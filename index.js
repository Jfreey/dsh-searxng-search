/**
 * Host half of the SearXNG search bundle.
 *
 * Registers one `ctx.web` search provider whose id is `searxng`, backed by a
 * local SearXNG instance (default `http://127.0.0.1:8888`), and keeps that
 * instance reachable: every search first probes the health endpoint and, when
 * the server is down, asks launchd to restart it or spawns the configured
 * command itself. A spawned child belongs to this plugin and is terminated when
 * the plugin unloads; a launchd-managed server is never owned here.
 *
 * Installation is deliberately not part of activation: creating a virtualenv and
 * pip-installing a server inside a plugin load would block the loader for
 * minutes and mutate the user's machine unasked. `scripts/bootstrap-searxng.sh`
 * performs that one-off install idempotently, and the plugin only ensures the
 * result stays running.
 *
 * The provider implements no `ready()`: the web service counts it ready, so
 * `web_search` stays admitted to every model step even while the server is
 * down, and the failure reaches the model as an actionable tool error instead
 * of a silently missing tool.
 *
 * @module dsh-searxng-search
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { registerEngineRoutes } from './engine-api.js'

const DEFAULT_BASE_URL = 'http://127.0.0.1:8888'
const DEFAULT_ID = 'searxng'
const DEFAULT_MAX_RESULTS = 20
const DEFAULT_TIMEOUT_MS = 20000
const USER_AGENT = 'dsh-searxng-search/0.3'
const DEFAULT_SETTINGS = join(homedir(), '.local/share/searxng/searxng.yml')

/**
 * Read a non-empty string config value, falling back when absent.
 * @param {unknown} value configured value
 * @param {string} fallback default
 */
function text(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

/**
 * Read a positive number config value, falling back when absent.
 * @param {unknown} value configured value
 * @param {number} fallback default
 */
function positive(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Project one SearXNG result onto the service's source vocabulary, dropping
 * entries no answer could cite.
 * @param {unknown} entry raw SearXNG result
 */
function sourceOf(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const url = typeof entry.url === 'string' ? entry.url.trim() : ''
  if (url.length === 0) return undefined

  const title = typeof entry.title === 'string' && entry.title.trim().length > 0 ? entry.title.trim() : undefined
  const snippet =
    typeof entry.content === 'string' && entry.content.trim().length > 0 ? entry.content.trim() : undefined
  const publishedAt =
    typeof entry.publishedDate === 'string' && entry.publishedDate.trim().length > 0
      ? entry.publishedDate.trim()
      : undefined

  return { url, title, snippet, publishedAt }
}

/**
 * Resolve the supervision settings, keeping every default in one place.
 * @param {Record<string, unknown>} raw `ensure` config block
 */
function ensureConfig(raw) {
  const block = raw !== null && typeof raw === 'object' ? raw : {}
  const args = Array.isArray(block.args) ? block.args.filter((a) => typeof a === 'string') : []
  const env =
    block.env !== null && typeof block.env === 'object'
      ? Object.fromEntries(Object.entries(block.env).filter(([, v]) => typeof v === 'string'))
      : {}
  return {
    enabled: block.enabled !== false,
    healthPath: text(block.healthPath, '/healthz'),
    probeTimeoutMs: Math.round(positive(block.probeTimeoutMs, 1500)),
    startupTimeoutMs: Math.round(positive(block.startupTimeoutMs, 20000)),
    probeIntervalMs: Math.round(positive(block.probeIntervalMs, 400)),
    retryCooldownMs: Math.round(positive(block.retryCooldownMs, 15000)),
    launchAgent: text(block.launchAgent, ''),
    systemdUnit: text(block.systemdUnit, ''),
    windowsTask: text(block.windowsTask, ''),
    windowsService: text(block.windowsService, ''),
    command: text(block.command, ''),
    args,
    cwd: text(block.cwd, ''),
    env,
  }
}

/**
 * Build the supervisor restarts this platform can use, in preference order.
 *
 * Each entry is one argv the plugin runs and then health-polls. Only the service
 * managers of the current platform are offered, so a macOS profile with a stale
 * `systemdUnit` present never runs systemctl, and a Windows profile with a
 * leftover `launchAgent` never shells out to a binary that is not there.
 *
 * @param {NodeJS.Platform | string} platform current platform id
 * @param {ReturnType<typeof ensureConfig>} ensure resolved supervision settings
 * @param {number} uid the invoking user id, for launchd's gui domain
 * @returns {{ label: string, argv: string[] }[]} candidate restarts
 */
function restartStrategies(platform, ensure, uid) {
  const candidates = []
  if (platform === 'darwin' && ensure.launchAgent.length > 0) {
    candidates.push({
      label: `launchctl kickstart ${ensure.launchAgent}`,
      argv: ['launchctl', 'kickstart', '-k', `gui/${uid}/${ensure.launchAgent}`],
    })
  }
  if (platform === 'linux' && ensure.systemdUnit.length > 0) {
    // A user unit needs no privileges; the system unit is the fallback for
    // deployments that installed SearXNG as a service.
    candidates.push({
      label: `systemctl --user restart ${ensure.systemdUnit}`,
      argv: ['systemctl', '--user', 'restart', ensure.systemdUnit],
    })
    candidates.push({
      label: `systemctl restart ${ensure.systemdUnit}`,
      argv: ['systemctl', 'restart', ensure.systemdUnit],
    })
  }
  if (platform === 'win32') {
    // A per-user scheduled task needs no elevation; a service needs admin, so
    // `sc` comes second and its failure is reported rather than retried.
    if (ensure.windowsTask.length > 0) {
      candidates.push({
        label: `schtasks /run /tn ${ensure.windowsTask}`,
        argv: ['schtasks', '/run', '/tn', ensure.windowsTask],
      })
    }
    if (ensure.windowsService.length > 0) {
      candidates.push({
        label: `sc start ${ensure.windowsService}`,
        argv: ['sc', 'start', ensure.windowsService],
      })
    }
  }
  return candidates
}

/**
 * Host plugin body.
 * @param {import('@deepseek-ai/cordis').Context} ctx owning context
 * @param {{ id?: string, baseUrl?: string, language?: string, categories?: string, engines?: string, safesearch?: number, maxResults?: number, timeoutMs?: number, ensure?: Record<string, unknown> }} [config]
 */
export function apply(ctx, config = {}) {
  const id = text(config.id, DEFAULT_ID)
  const baseUrl = text(config.baseUrl, DEFAULT_BASE_URL).replace(/\/+$/, '')
  const language = text(config.language, '')
  const categories = text(config.categories, '')
  const engines = text(config.engines, '')
  const safesearch = Number.isInteger(config.safesearch) ? config.safesearch : 0
  const providerMax = Math.round(positive(config.maxResults, DEFAULT_MAX_RESULTS))
  const timeoutMs = Math.round(positive(config.timeoutMs, DEFAULT_TIMEOUT_MS))
  const settingsPath = text(config.settingsPath, DEFAULT_SETTINGS)
  const ensure = ensureConfig(config.ensure)

  /** Child this plugin started and therefore owns; a launchd server is never here. */
  let owned
  /** Last failed supervision attempt, used to back off instead of hammering. */
  let lastFailure
  /** One in-flight recovery shared by concurrent searches. */
  let recovering

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /**
   * Ask the health endpoint whether the server answers.
   * @returns {Promise<boolean>} reachable and healthy
   */
  const probe = async () => {
    try {
      const response = await fetch(`${baseUrl}${ensure.healthPath}`, {
        method: 'GET',
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(ensure.probeTimeoutMs),
      })
      return response.ok
    } catch {
      return false
    }
  }

  /** Read the tail of a collected stream without failing on an absent reader. */
  const tailOf = (reader) => {
    if (reader === undefined) return ''
    try {
      const text = reader.readFrom(0).text.trim()
      return text.length > 400 ? `…${text.slice(-400)}` : text
    } catch {
      return ''
    }
  }

  /**
   * Start the server: this platform's service manager first, then the
   * configured command, whose process this plugin owns.
   * @returns {Promise<string>} the strategy that ran
   */
  const start = async () => {
    const platform = typeof process !== 'undefined' ? process.platform : 'linux'
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501
    const subprocess = ctx.get('subprocess')
    const issues = []

    for (const strategy of restartStrategies(platform, ensure, uid)) {
      if (subprocess === undefined) {
        issues.push(`${strategy.label}: the subprocess service is unavailable`)
        break
      }
      const handle = subprocess.spawn({
        argv: strategy.argv,
        cwd: ensure.cwd.length > 0 ? ensure.cwd : process.cwd(),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 2048 },
          stderr: { maxBytes: 2048 },
        },
        graceMs: 5000,
      })
      const outcome = await handle.done
      if (outcome.exitCode === 0) return strategy.label
      const detail = tailOf(handle.collected.stderr)
      issues.push(`${strategy.label} exited ${outcome.exitCode}${detail.length > 0 ? `: ${detail}` : ''}`)
    }

    if (ensure.command.length === 0) {
      const attempted = issues.length > 0 ? ` Tried: ${issues.join('; ')}.` : ''
      throw new Error(
        `SearXNG is not reachable at ${baseUrl} and this plugin has no way to start it.${attempted} ` +
          `Set ensure.launchAgent (macOS), ensure.systemdUnit (Linux), ensure.windowsTask or ` +
          `ensure.windowsService (Windows), or ensure.command, ` +
          `or run the bundled installer to create one.`,
      )
    }

    if (subprocess === undefined) {
      throw new Error('SearXNG is down and the subprocess service is unavailable, so it cannot be started.')
    }

    const handle = subprocess.spawn({
      argv: [ensure.command, ...ensure.args],
      cwd: ensure.cwd.length > 0 ? ensure.cwd : process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4096 },
        stderr: { maxBytes: 4096 },
      },
      graceMs: 3000,
      env: Object.keys(ensure.env).length > 0 ? { ...process.env, ...ensure.env } : undefined,
    })
    owned = handle
    // A crashed child must not be reported as regenerated on the next probe.
    handle.done.then(
      (outcome) => {
        if (owned === handle) owned = undefined
        if (outcome.exitCode !== 0) {
          const detail = tailOf(handle.collected.stderr)
          ctx.logger?.warn(`searxng-search: server exited (${outcome.exitCode}) ${detail}`)
        }
      },
      () => {
        if (owned === handle) owned = undefined
      },
    )
    return `spawn ${ensure.command}`
  }

  /**
   * Look for a SearXNG instance on nearby loopback ports.
   *
   * Only runs after a failure, to turn "unreachable" into something actionable:
   * a port clash is the usual cause, and the person reading the error should not
   * have to guess which port the other instance took. A candidate counts only if
   * it answers `/healthz` *and* `/config` returns an engine list, so an unrelated
   * service on a nearby port is never reported as a find.
   *
   * @returns {Promise<number[]>} ports that answered as SearXNG
   */
  const discover = async () => {
    const configured = Number(new URL(baseUrl).port || 80)
    const found = []
    for (let port = 8888; port <= 8896; port += 1) {
      if (port === configured) continue
      try {
        const health = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(400) })
        if (!health.ok) continue
        const config = await fetch(`http://127.0.0.1:${port}/config`, { signal: AbortSignal.timeout(800) })
        const body = await config.json()
        if (body !== null && typeof body === 'object' && Array.isArray(body.engines)) found.push(port)
      } catch {
        // not a SearXNG, or nothing there
      }
    }
    return found
  }

  /**
   * Bring the server up if it is down, waiting at most startupTimeoutMs.
   * Concurrent searches share one recovery attempt.
   * @returns {Promise<void>}
   */
  const ensureUp = async () => {
    if (await probe()) return
    if (!ensure.enabled) {
      throw new Error(`SearXNG at ${baseUrl} is not answering and ensure.enabled is false.`)
    }
    if (lastFailure !== undefined && Date.now() - lastFailure.at < ensure.retryCooldownMs) {
      throw lastFailure.error
    }
    if (recovering !== undefined) return recovering

    recovering = (async () => {
      const strategy = await start()
      const deadline = Date.now() + ensure.startupTimeoutMs
      while (Date.now() < deadline) {
        if (await probe()) {
          lastFailure = undefined
          ctx.logger?.info(`searxng-search: ${baseUrl} is up (${strategy})`)
          return
        }
        await wait(ensure.probeIntervalMs)
      }
      const detail = tailOf(owned?.collected.stderr)
      const error = new Error(
        `SearXNG at ${baseUrl} did not become healthy within ${ensure.startupTimeoutMs} ms ` +
          `after ${strategy}.${detail.length > 0 ? ` Server output: ${detail}` : ''}`,
      )
      lastFailure = { at: Date.now(), error }
      throw error
    })()

    try {
      await recovering
    } finally {
      recovering = undefined
    }
  }

  /**
   * Run one search against the local instance.
   * @param {{ query: string, maxResults?: number }} request service request
   * @param {AbortSignal} [signal] caller cancellation
   */
  const search = async (request, signal) => {
    try {
      await ensureUp()
    } catch (error) {
      const elsewhere = await discover()
      if (elsewhere.length > 0) {
        throw new Error(
          `${error.message} A SearXNG instance does answer on ${elsewhere
            .map((port) => `http://127.0.0.1:${port}`)
            .join(', ')}; set config.baseUrl to that address.`,
        )
      }
      throw error
    }

    const wanted = Math.min(providerMax, Math.max(1, request.maxResults ?? providerMax))
    const url = new URL(`${baseUrl}/search`)
    url.searchParams.set('q', request.query)
    url.searchParams.set('format', 'json')
    url.searchParams.set('safesearch', String(safesearch))
    if (language.length > 0) url.searchParams.set('language', language)
    if (categories.length > 0) url.searchParams.set('categories', categories)
    if (engines.length > 0) url.searchParams.set('engines', engines)

    // Local timeouts cancel the request; the caller's signal still wins so a
    // cancelled step never waits for the timer.
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

    let response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: combined,
      })
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.name === 'TimeoutError') {
        throw new Error(`SearXNG at ${baseUrl} did not answer within ${timeoutMs} ms.`)
      }
      if (signal?.aborted === true) throw error
      throw new Error(`Could not reach SearXNG at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (!response.ok) {
      throw new Error(
        `SearXNG answered HTTP ${response.status}. Check that the instance allows the JSON format ` +
          `(search.formats must include json in its settings file).`,
      )
    }

    let body
    try {
      body = await response.json()
    } catch {
      throw new Error(`SearXNG at ${baseUrl} did not return JSON; the instance likely has the json format disabled.`)
    }

    const raw = body !== null && typeof body === 'object' && Array.isArray(body.results) ? body.results : []
    const sources = []
    const seen = new Set()
    for (const entry of raw) {
      const source = sourceOf(entry)
      if (source === undefined || seen.has(source.url)) continue
      seen.add(source.url)
      sources.push(source)
      if (sources.length >= wanted) break
    }

    return { sources, truncated: raw.length > sources.length }
  }

  // Own a process only while this plugin lives; a launchd server outlives it.
  ctx.effect(() => () => {
    const child = owned
    owned = undefined
    child?.terminate()
  })

  ctx.effect(() => ctx.web.registerSearchProvider({ id, available: () => true, search }))

  // The settings page reads and rewrites the instance's own settings file, so it
  // needs the path and the same restart path every other recovery uses.
  //
  // `webServer` is asked for, not injected: the provider above must work in a
  // profile that has no Web app at all. On a cold boot that service can mount
  // after this row, and a single `ctx.get` would then register nothing and leave
  // every route 404 until the next reload — so wait for it instead of sampling
  // once.
  const routes = {
    baseUrl,
    settingsPath,
    probeTimeoutMs: Math.max(4000, Math.round(positive(config.probeTimeoutMs, 12000))),
    restart: async () => start(),
    healthy: probe,
  }
  ctx.effect(() => {
    let dispose = ctx.get('webServer') === undefined ? undefined : registerEngineRoutes(ctx, routes)
    if (dispose !== undefined) return () => dispose()

    let attempts = 0
    const timer = setInterval(() => {
      attempts += 1
      if (ctx.get('webServer') !== undefined) {
        clearInterval(timer)
        dispose = registerEngineRoutes(ctx, routes)
        ctx.logger?.info('searxng-search: webServer appeared late; engine routes registered')
        return
      }
      if (attempts >= 200) {
        clearInterval(timer)
        ctx.logger?.warn('searxng-search: webServer never mounted; engine routes are unavailable in this profile')
      }
    }, 250)

    return () => {
      clearInterval(timer)
      dispose?.()
    }
  })
}

export const inject = ['web']
