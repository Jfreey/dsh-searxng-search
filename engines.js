/**
 * Pure helpers behind the SearXNG engine page: probe scoring and the two
 * settings-file regions the plugin owns (the enabled roster and the outbound
 * proxy). Kept free of I/O so the scoring and the text surgery are testable on
 * their own.
 *
 * @module dsh-searxng-search/engines
 */

/**
 * Classify one engine probe into a 0–100 usability score.
 *
 * The score is explicitly *not* an accuracy metric: nothing here compares an
 * engine's answers with ground truth. It answers "would turning this engine on
 * make my searches better or slower", from three observable facts — did it
 * answer, how fast, and did it produce anything.
 *
 * @param {{ ok: boolean, latencyMs: number, results: number }} probe measurements
 * @returns {number} 0–100
 */
export function scoreOf(probe) {
  if (!probe.ok) return 0
  const latency = probe.latencyMs
  const latencyPoints = latency <= 800 ? 25 : latency <= 2000 ? 18 : latency <= 5000 ? 10 : latency <= 15000 ? 4 : 0
  const yieldPoints = probe.results >= 5 ? 20 : probe.results >= 1 ? 12 : 4
  return Math.min(100, 55 + latencyPoints + yieldPoints)
}

/**
 * Decide the recommended roster from probe results: usable engines, best first,
 * with a floor so a slow-but-working engine is not silently dropped.
 * @param {{ name: string, score: number }[]} results scored probes
 * @param {number} [floor] minimum score to recommend
 * @returns {string[]} engine names
 */
export function recommend(results, floor = 60) {
  return results
    .filter((entry) => entry.score >= floor)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.name)
}

/**
 * Whether a line starts one entry of the top-level `engines:` list.
 *
 * Upstream's settings file writes entries as `- disabled: false` at column 0,
 * while this plugin's generated file writes `  - name: x`; both are valid YAML
 * and both have to be replaced, or a roster edit leaves the old entries behind
 * and the file no longer parses.
 * @param {string} line one line of settings.yml
 */
function isEngineItem(line) {
  return /^- /.test(line) || /^  - /.test(line)
}

/**
 * Whether a line is the indented body of the previous `engines:` entry.
 * @param {string} line one line of settings.yml
 */
function isEngineField(line) {
  return /^ {2}\S/.test(line) || /^ {4}\S/.test(line)
}



/**
 * Set or clear the `outgoing.proxies` block SearXNG uses for engine requests.
 *
 * `url === null` removes the block entirely, returning the instance to direct
 * connections. A non-empty URL is written as the `all://` network so every
 * engine uses it, including ones that fetch media.
 *
 * @param {string} text current settings.yml
 * @param {string | null} url proxy URL, e.g. `http://127.0.0.1:7890`
 * @returns {string} patched settings.yml
 */
export function writeProxy(text, url) {
  const lines = text.split('\n')
  const outgoing = lines.findIndex((line) => /^outgoing:\s*$/.test(line))

  if (outgoing === -1) {
    if (url === null) return text
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    lines.push('', 'outgoing:', '  proxies:', '    all://:', `      - ${url}`, '')
    return lines.join('\n')
  }

  // The outgoing block runs until the next column-0 key.
  let blockEnd = outgoing + 1
  while (blockEnd < lines.length && (lines[blockEnd] === '' || /^\s/.test(lines[blockEnd]))) {
    if (lines[blockEnd] === '') break
    blockEnd += 1
  }

  const proxies = lines.findIndex((line, index) => index > outgoing && index < blockEnd && /^  proxies:\s*$/.test(line))
  if (url === null) {
    if (proxies === -1) return text
    let end = proxies + 1
    while (end < lines.length && /^\s{4,}\S/.test(lines[end])) end += 1
    lines.splice(proxies, end - proxies)
    return lines.join('\n')
  }

  const block = ['  proxies:', '    all://:', `      - ${url}`]
  if (proxies === -1) {
    lines.splice(outgoing + 1, 0, ...block)
    return lines.join('\n')
  }
  let end = proxies + 1
  while (end < lines.length && /^\s{4,}\S/.test(lines[end])) end += 1
  lines.splice(proxies, end - proxies, ...block)
  return lines.join('\n')
}

/**
 * Read the proxy currently configured for engine requests.
 * @param {string} text current settings.yml
 * @returns {string | null} the `all://` proxy URL, or null
 */
export function readProxy(text) {
  const lines = text.split('\n')
  const outgoing = lines.findIndex((line) => /^outgoing:\s*$/.test(line))
  if (outgoing === -1) return null
  for (let index = outgoing + 1; index < lines.length; index += 1) {
    if (lines[index] === '' || !/^\s/.test(lines[index])) break
    const match = /^\s+- (\S+)$/.exec(lines[index])
    if (match !== null && index > outgoing + 1 && /all:\/\/:/.test(lines[index - 1] ?? '')) return match[1]
  }
  return null
}

/**
 * Parse a SearXNG `/search` response into one engine's probe measurement.
 * @param {unknown} body decoded JSON
 * @param {number} latencyMs measured round trip
 * @param {string} engine engine name
 */
export function measure(body, latencyMs, engine) {
  const unresponsive = body !== null && typeof body === 'object' && Array.isArray(body.unresponsive_engines)
    ? body.unresponsive_engines
    : []
  const failure = unresponsive.find((entry) => Array.isArray(entry) && entry[0] === engine)
  const results = body !== null && typeof body === 'object' && Array.isArray(body.results) ? body.results.length : 0

  if (failure !== undefined) {
    return { ok: false, latencyMs, results: 0, error: String(failure[1] ?? 'engine error') }
  }
  return { ok: true, latencyMs, results, error: undefined }
}


/**
 * Collapse `use_default_settings` to plain `true`.
 *
 * Once the file carries one explicit switch per engine, the merge directives are
 * pointless — and a half-removed one is worse than useless: emptying `keep_only`
 * leaves `use_default_settings.engines` as null, which SearXNG's loader treats as
 * a mapping and crashes on (`'NoneType' object has no attribute 'get'`).
 *
 * @param {string} text current settings.yml
 * @returns {string} settings.yml with a scalar `use_default_settings`
 */
export function normalizeUseDefaults(text) {
  const lines = text.split('\n')
  const header = lines.findIndex((line) => /^use_default_settings:\s*/.test(line))
  if (header === -1) return text
  let end = header + 1
  while (end < lines.length && (/^\s+\S/.test(lines[end]) || lines[end] === '')) {
    if (lines[end] === '') break
    end += 1
  }
  lines.splice(header, end - header, 'use_default_settings: true')
  return lines.join('\n')
}

/**
 * Write the complete engine roster as explicit switches, quoting every name so
 * engines with spaces (`bing news`) stay valid YAML.
 * @param {string} text current settings.yml
 * @param {{ name: string, enabled: boolean }[]} entries every known engine
 * @returns {string} settings.yml
 */
export function writeFullRoster(text, entries) {
  const lines = text.split('\n')
  const block = entries.flatMap((entry) => [`  - name: "${entry.name}"`, `    disabled: ${entry.enabled ? 'false' : 'true'}`])

  const header = lines.findIndex((line) => /^engines:\s*$/.test(line))
  if (header === -1) {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    lines.push('', '# Written by dsh-searxng-search: one switch per engine.', 'engines:', ...block, '')
    return lines.join('\n')
  }

  let end = header + 1
  while (end < lines.length && (isEngineItem(lines[end]) || isEngineField(lines[end]))) end += 1
  lines.splice(header + 1, end - header - 1, ...block)
  return lines.join('\n')
}

/**
 * Read engine names out of the instance's upstream defaults file, which lists
 * every engine the install *could* run. This is what keeps the settings page
 * complete even when the active roster is narrow.
 * @param {string} text contents of `searx/settings.yml`
 * @returns {string[]} engine names
 */
export function catalogNames(text) {
  const names = []
  for (const line of text.split('\n')) {
    const match = /^\s*- name: (.+)$/.exec(line)
    if (match === null) continue
    const name = match[1].trim().replace(/^["']|["']$/g, '')
    if (name.length > 0 && !names.includes(name)) names.push(name)
  }
  return names
}
