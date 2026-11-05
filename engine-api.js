/**
 * Host routes behind the SearXNG settings page: read the current roster, probe
 * the engines the host can actually reach, apply a recommended roster, and set
 * or clear the outbound proxy.
 *
 * Every route answers JSON on the plugin's own path prefix; the Client page is
 * a thin rendering of these responses.
 *
 * @module dsh-searxng-search/engine-api
 */

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  catalogNames,
  measure,
  readProxy,
  recommend,
  scoreOf,
  normalizeUseDefaults,
  writeFullRoster,
  writeProxy,
} from './engines.js'

const PREFIX = '/dsh-searxng'
const PROBE_QUERY = 'searxng'
const PROBE_CONCURRENCY = 3

/**
 * Send one JSON response.
 * @param {import('node:http').ServerResponse} response target
 * @param {number} status HTTP status
 * @param {unknown} body JSON payload
 */
function send(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

/**
 * Read a JSON request body with a size cap.
 * @param {import('node:http').IncomingMessage} request source
 * @returns {Promise<Record<string, unknown>>} parsed body, or an empty object
 */
async function bodyOf(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('Request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/**
 * Register the engine routes on the plugin's web path.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx owning context
 * @param {{
 *   baseUrl: string,
 *   settingsPath: string,
 *   probeTimeoutMs: number,
 *   restart: () => Promise<string>,
 *   healthy: () => Promise<boolean>,
 * }} deps host capabilities the routes reuse
 * @returns {() => void} disposer
 */
export function registerEngineRoutes(ctx, deps) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return () => {}

  /** Last probe run, so the page can render immediately after a reload. */
  let lastProbe
  /** Upstream defaults listing every engine this install could run. */
  const defaultsPath = join(dirname(deps.settingsPath), 'searx', 'settings.yml')

  /**
   * Read the instance's engine roster.
   * @returns {Promise<{ engines: {name: string, enabled: boolean, categories: string[]}[] }>}
   */
  const roster = async () => {
    const response = await fetch(`${deps.baseUrl}/config`, { signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error(`SearXNG /config answered HTTP ${response.status}`)
    const body = await response.json()
    const engines = Array.isArray(body.engines) ? body.engines : []
    return {
      engines: engines.map((engine) => ({
        name: String(engine.name ?? ''),
        enabled: engine.enabled === true,
        categories: Array.isArray(engine.categories) ? engine.categories.map(String) : [],
        timeout: typeof engine.timeout === 'number' ? engine.timeout : undefined,
      })),
    }
  }

  /**
   * The full engine universe: everything the install could run, with its current
   * switch state. Reading only `/config` would shrink the page to the active
   * roster — a `keep_only` whitelist makes every other engine invisible and
   * unreachable, which is exactly the one-way door this page has to avoid.
   * @returns {Promise<{name: string, enabled: boolean, active: boolean}[]>}
   */
  const catalog = async () => {
    const { engines } = await roster()
    // `/config` is the only reliable source of categories: the upstream defaults
    // file leaves `categories` off most entries, so a name parsed from it knows
    // nothing about where it belongs.
    const merged = engines.map((engine) => ({
      name: engine.name,
      enabled: engine.enabled,
      active: true,
      categories: engine.categories,
    }))
    const seen = new Set(merged.map((engine) => engine.name))

    try {
      for (const name of catalogNames(readFileSync(defaultsPath, 'utf8'))) {
        if (seen.has(name)) continue
        merged.push({ name, enabled: false, active: false, categories: [] })
      }
    } catch {
      // No defaults file beside the settings: the live roster is all we know.
    }
    return merged
  }

  /**
   * Probe one engine with a fixed query and score the outcome.
   * @param {string} name engine name
   * @param {string} query probe query
   */
  const probeOne = async (name, query) => {
    const url = new URL(`${deps.baseUrl}/search`)
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    url.searchParams.set('engines', name)
    const started = Date.now()
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(deps.probeTimeoutMs) })
      const latencyMs = Date.now() - started
      if (!response.ok) {
        return { name, ok: false, latencyMs, results: 0, error: `HTTP ${response.status}`, score: 0 }
      }
      const measured = measure(await response.json(), latencyMs, name)
      return { name, ...measured, score: scoreOf(measured) }
    } catch (error) {
      const latencyMs = Date.now() - started
      const timeout = error !== null && typeof error === 'object' && error.name === 'TimeoutError'
      return {
        name,
        ok: false,
        latencyMs,
        results: 0,
        error: timeout ? `timeout after ${deps.probeTimeoutMs} ms` : String(error?.message ?? error),
        score: 0,
      }
    }
  }

  /**
   * Probe several engines with bounded concurrency.
   * @param {string[]} names engine names
   * @param {string} query probe query
   */
  const probeMany = async (names, query) => {
    const queue = [...names]
    const out = []
    const worker = async () => {
      for (;;) {
        const name = queue.shift()
        if (name === undefined) return
        out.push(await probeOne(name, query))
      }
    }
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, worker))
    return out.sort((a, b) => b.score - a.score)
  }

  /**
   * Wait for the instance to answer again after a settings rewrite.
   * @param {number} budgetMs how long to keep trying
   */
  const waitHealthy = async (budgetMs) => {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      if (await deps.healthy()) return true
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    return false
  }

  /** Write the settings file with a timestamped backup beside it. */
  const writeSettings = (transform) => {
    const original = readFileSync(deps.settingsPath, 'utf8')
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
    const backup = `${deps.settingsPath}.bak-${stamp}`
    copyFileSync(deps.settingsPath, backup)
    writeFileSync(deps.settingsPath, transform(original))
    return { backup, original }
  }

  const handler = async (request, response, action) => {
    try {
      if (action === 'engines') {
        if (request.method !== 'GET') return send(response, 405, { ok: false, error: { code: 'METHOD' } })
        const engines = await catalog()
        let proxy = null
        try {
          proxy = readProxy(readFileSync(deps.settingsPath, 'utf8'))
        } catch {
          proxy = null
        }
        // The page shows a home-relative path so a screenshot never carries the
        // user's name; the absolute path stays available for tooltips.
        const home = homedir()
        const shortPath = deps.settingsPath.startsWith(home) ? `~${deps.settingsPath.slice(home.length)}` : deps.settingsPath
        return send(response, 200, {
          ok: true,
          baseUrl: deps.baseUrl,
          settingsPath: deps.settingsPath,
          settingsPathShort: shortPath,
          proxy,
          engines,
          probe: lastProbe ?? null,
        })
      }

      if (action === 'probe') {
        if (request.method !== 'POST') return send(response, 405, { ok: false, error: { code: 'METHOD' } })
        const body = await bodyOf(request)
        const query = typeof body.query === 'string' && body.query.trim().length > 0 ? body.query.trim() : PROBE_QUERY
        let names = Array.isArray(body.engines) ? body.engines.filter((n) => typeof n === 'string') : undefined
        if (names === undefined || names.length === 0) {
          // Probing every enabled engine would fan out over media and map
          // engines that a text search never touches; the general roster is the
          // set that actually decides whether web_search is useful.
          const { engines } = await roster()
          names = engines.filter((e) => e.enabled && e.categories.includes('general')).map((e) => e.name)
        }
        const started = Date.now()
        const results = await probeMany(names, query)
        lastProbe = { at: new Date().toISOString(), query, tookMs: Date.now() - started, results }
        return send(response, 200, { ok: true, ...lastProbe, recommended: recommend(results) })
      }

      if (action === 'apply') {
        if (request.method !== 'POST') return send(response, 405, { ok: false, error: { code: 'METHOD' } })
        const body = await bodyOf(request)
        const names = Array.isArray(body.engines) ? body.engines.filter((n) => typeof n === 'string' && n.length > 0) : []
        if (names.length === 0) return send(response, 400, { ok: false, error: { code: 'EMPTY' } })
        // One explicit switch per engine, and no `keep_only`: the whitelist
        // would hide every unselected engine from the next probe and the next
        // apply, so a recommendation could never be widened again.
        const wanted = new Set(names)
        const universe = await catalog()
        const entries = universe.map((engine) => ({ name: engine.name, enabled: wanted.has(engine.name) }))
        for (const name of names) {
          if (!entries.some((entry) => entry.name === name)) entries.push({ name, enabled: true })
        }
        // `normalizeUseDefaults`, not just removing the list: an emptied
        // `use_default_settings.engines` parses as null and the loader crashes on
        // it, which is exactly how the first version of this fix failed.
        const { backup } = writeSettings((original) => writeFullRoster(normalizeUseDefaults(original), entries))
        const strategy = await deps.restart()
        const healthy = await waitHealthy(20000)
        if (!healthy) {
          copyFileSync(backup, deps.settingsPath)
          await deps.restart()
          return send(response, 500, {
            ok: false,
            error: { code: 'UNHEALTHY', message: 'The instance did not come back after the roster change; the previous settings were restored.' },
            backup,
          })
        }
        let verified = null
        try {
          const { engines } = await roster()
          verified = engines.filter((engine) => engine.enabled).map((engine) => engine.name)
        } catch {
          verified = null
        }
        return send(response, 200, { ok: true, applied: names, backup, strategy, verified })
      }

      if (action === 'proxy') {
        if (request.method !== 'POST') return send(response, 405, { ok: false, error: { code: 'METHOD' } })
        const body = await bodyOf(request)
        const raw = body.url
        const url = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
        if (url !== null && !/^(https?|socks4|socks5)h?:\/\//i.test(url)) {
          return send(response, 400, { ok: false, error: { code: 'BAD_URL', message: 'Use http://, https://, socks4:// or socks5://.' } })
        }
        const { backup } = writeSettings((original) => writeProxy(original, url))
        const strategy = await deps.restart()
        const healthy = await waitHealthy(20000)
        if (!healthy) {
          copyFileSync(backup, deps.settingsPath)
          await deps.restart()
          return send(response, 500, { ok: false, error: { code: 'UNHEALTHY', message: 'Restart failed; the previous settings were restored.' }, backup })
        }
        return send(response, 200, { ok: true, proxy: url, backup, strategy })
      }

      return send(response, 404, { ok: false, error: { code: 'UNKNOWN_ACTION' } })
    } catch (error) {
      ctx.logger?.warn(`searxng-search: ${action} failed`)
      ctx.logger?.warn(error)
      return send(response, 500, { ok: false, error: { code: 'INTERNAL', message: String(error?.message ?? error) } })
    }
  }

  const disposers = ['engines', 'probe', 'apply', 'proxy'].map((action) =>
    webServer.register({
      kind: 'exact',
      path: `${PREFIX}/${action}`,
      handler: (request, response) => handler(request, response, action),
    }),
  )

  return () => {
    for (const dispose of disposers) dispose()
  }
}
