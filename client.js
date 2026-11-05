/**
 * Client half of the SearXNG search bundle: one Settings page that shows the
 * engine roster, measures which engines this host can actually reach, applies a
 * recommended roster, and sets or clears the outbound proxy.
 *
 * Everything is server-measured; the page renders the Host routes in
 * `engine-api.js` and never touches the settings file itself.
 */
window.__ModuleLoader__.load({
  id: 'dsh-searxng-search',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'searxng-search'
    const ENDPOINT = '/dsh-searxng'

    const zh = {
      nav: 'SearXNG 搜索',
      title: 'SearXNG 引擎',
      subtitle: '按当前宿主机网络实测，决定开哪些搜索引擎',
      loading: '正在读取引擎列表…',
      probe: '测试全部已启用引擎',
      probing: '测试中…',
      apply: '应用所选引擎',
      applying: '应用中…',
      selectRecommended: '选中推荐',
      recommended: '推荐',
      enabled: '已启用',
      disabled: '未启用',
      score: '可用度',
      latency: '延迟',
      results: '结果',
      error: '失败原因',
      engine: '引擎',
      noProbe: '还没有测试结果。点上面的按钮，按当前网络实测一遍。',
      lastProbe: '上次测试',
      took: '耗时',
      applied: '已写入并重启，当前启用',
      proxyTitle: '出站代理',
      proxyHint: 'SearXNG 的引擎请求走这个代理；留空则直连。支持 http://、https://、socks5://。',
      proxyPlaceholder: 'http://127.0.0.1:7890',
      save: '保存代理',
      clear: '清除代理',
      saving: '保存中…',
      proxySaved: '代理已保存并重启',
      proxyCleared: '代理已清除，恢复直连',
      errorTitle: '操作失败',
      emptySelection: '至少选一个引擎。',
      backup: '备份',
      settingsAt: '配置文件',
      scoreNote: '可用度 = 能否应答 + 延迟 + 产出条数；不是准确率。',
      bugHint: '准确率需要标准答案，这里不测。',
      refresh: '刷新列表',
      cat_general: '通用',
      cat_news: '新闻',
      cat_images: '图片',
      cat_videos: '视频',
      cat_music: '音乐',
      cat_it: '技术',
      cat_science: '科学',
      cat_files: '文件',
      cat_social_media: '社交',
      cat_map: '地图',
      cat_other: '其他',
      showAll: '显示全部引擎',
      notListed: '不在当前名单',
      allNote: '名单外的引擎应用后即可用',
      groupOther: '其他',
      err_BAD_URL: '代理地址格式不对，用 http://、https://、socks4:// 或 socks5://。',
      err_EMPTY: '至少选一个引擎。',
      err_UNHEALTHY: '实例没能在重启后恢复，已回滚到上一份配置。',
      err_INTERNAL: '插件内部错误，详情看宿主日志。',
      err_NETWORK: '连不上本机 SearXNG。',
      autoTesting: '正在测试已勾选的引擎…',
      adviceTitle: '建议',
      adviceAllGood: '已勾选的引擎全部可用。',
      adviceOff: '建议关闭',
      adviceReasonBlocked: '被拦截',
      adviceReasonEmpty: '没有结果',
      adviceReasonSlow: '太慢',
      adviceQuiet: '这些返回 0 条，多半是探针词不适用，不代表不可用',
      adviceApply: '按建议调整勾选',
    }

    const en = {
      nav: 'SearXNG search',
      title: 'SearXNG engines',
      subtitle: 'Decide which engines to enable from what this host can actually reach',
      loading: 'Reading the engine roster…',
      probe: 'Probe enabled engines',
      probing: 'Probing…',
      apply: 'Apply selected',
      applying: 'Applying…',
      selectRecommended: 'Select recommended',
      recommended: 'Recommended',
      enabled: 'Enabled',
      disabled: 'Off',
      score: 'Usable',
      latency: 'Latency',
      results: 'Results',
      error: 'Failure',
      engine: 'Engine',
      noProbe: 'No measurements yet. Run a probe to test this host’s network.',
      lastProbe: 'Last probe',
      took: 'took',
      applied: 'Written and restarted; now enabled',
      proxyTitle: 'Outbound proxy',
      proxyHint: 'SearXNG sends engine requests through this proxy. Empty means direct. http(s) and socks5 supported.',
      proxyPlaceholder: 'http://127.0.0.1:7890',
      save: 'Save proxy',
      clear: 'Clear proxy',
      saving: 'Saving…',
      proxySaved: 'Proxy saved and restarted',
      proxyCleared: 'Proxy cleared; direct connections restored',
      errorTitle: 'Action failed',
      emptySelection: 'Select at least one engine.',
      backup: 'Backup',
      settingsAt: 'Settings file',
      scoreNote: 'Usable = answers + latency + result count. Not accuracy.',
      bugHint: 'Accuracy needs ground truth, which is not measured here.',
      refresh: 'Reload',
      cat_general: 'General',
      cat_news: 'News',
      cat_images: 'Images',
      cat_videos: 'Videos',
      cat_music: 'Music',
      cat_it: 'Tech',
      cat_science: 'Science',
      cat_files: 'Files',
      cat_social_media: 'Social',
      cat_map: 'Maps',
      cat_other: 'Other',
      showAll: 'Show every engine',
      notListed: 'Not in roster',
      allNote: 'Engines outside the roster become usable once applied',
      groupOther: 'Other',
      err_BAD_URL: 'That proxy URL is not valid. Use http://, https://, socks4:// or socks5://.',
      err_EMPTY: 'Select at least one engine.',
      err_UNHEALTHY: 'The instance did not come back after the restart; the previous settings were restored.',
      err_INTERNAL: 'Internal plugin error; see the host log.',
      err_NETWORK: 'Cannot reach the local SearXNG.',
      autoTesting: 'Probing the selected engines…',
      adviceTitle: 'Suggestions',
      adviceAllGood: 'Every selected engine answered.',
      adviceOff: 'Turn off',
      adviceReasonBlocked: 'blocked',
      adviceReasonEmpty: 'no results',
      adviceReasonSlow: 'slow',
      adviceQuiet: 'Zero results here usually means the probe query does not fit these engines, not that they are broken',
      adviceApply: 'Select the working set',
    }

    const CSS = `
.sx-page{--sx-line:var(--dsw-alias-border-l1);--sx-soft:var(--dsw-alias-border-l2);--sx-brand:var(--dsw-alias-brand-primary);--sx-warn:var(--dsw-alias-state-warn-primary);--sx-error:var(--dsw-alias-state-error-primary);display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-secondary);font-size:calc(var(--dsh-content-font-size-secondary,13px));line-height:20px}
.sx-head{display:flex;flex-direction:column;gap:4px}
.sx-title{color:var(--dsw-alias-label-primary);font-weight:500;font-size:14px;line-height:22px}
.sx-sub{color:var(--dsw-alias-label-tertiary)}
.sx-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.sx-btn{box-sizing:border-box;padding:4px 12px;border:1px solid var(--sx-line);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.sx-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.sx-btn:focus-visible{outline:2px solid var(--sx-brand);outline-offset:2px}
.sx-btn:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;opacity:.7}
.sx-btn[data-primary=true]{border-color:var(--sx-brand);color:var(--sx-brand)}
.sx-meta{display:flex;flex-wrap:wrap;gap:4px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}
.sx-table{display:flex;flex-direction:column;border:1px solid var(--sx-line);border-radius:var(--dsw-radius-sm);overflow:hidden}
.sx-row{display:grid;grid-template-columns:24px minmax(120px,1.4fr) 64px 88px 1fr 64px 56px;align-items:center;gap:8px;padding:5px 10px;border-bottom:1px solid var(--sx-soft)}
.sx-row:last-child{border-bottom:0}
.sx-group{display:flex;align-items:baseline;gap:8px;padding:6px 10px 3px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;letter-spacing:.04em;text-transform:uppercase}
.sx-group__count{font-variant-numeric:tabular-nums;opacity:.7}
.sx-row[data-head=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;text-transform:none}
.sx-name{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sx-tag{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.sx-tag[data-on=true]{color:var(--sx-brand)}
.sx-num{font-variant-numeric:tabular-nums;text-align:right}
.sx-track{position:relative;height:4px;background:var(--sx-soft);overflow:hidden}
.sx-fill{position:absolute;inset:0 auto 0 0;background:var(--sx-brand)}
.sx-fill[data-low=true]{background:var(--sx-warn)}
.sx-why{color:var(--sx-error);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sx-box{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--sx-line);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}
.sx-box__head{color:var(--dsw-alias-label-primary);font-weight:500}
.sx-field{display:flex;gap:8px;align-items:center}
.sx-input{flex:1;box-sizing:border-box;min-width:0;padding:4px 8px;border:1px solid var(--sx-line);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.sx-input:focus-visible{outline:2px solid var(--sx-brand);outline-offset:1px}
.sx-note{color:var(--dsw-alias-label-tertiary);font-size:11px}
.sx-msg{padding:6px 10px;border:1px solid var(--sx-line);border-left:2px solid var(--sx-brand);background:var(--dsw-alias-bg-layer-1);font-size:12px}
.sx-msg[data-kind=error]{border-left-color:var(--sx-error);color:var(--dsw-alias-label-primary)}
.sx-advice{display:flex;flex-direction:column;gap:2px}
.sx-advice__row{display:grid;grid-template-columns:minmax(120px,1.2fr) 1fr;gap:8px;align-items:baseline}
.sx-pick{accent-color:var(--sx-brand);margin:0;cursor:pointer}
`

    /**
     * One request against the plugin's host routes.
     * @param {string} action route segment
     * @param {Record<string, unknown>} [body] JSON body; omit for GET
     */
    const request = async (action, body) => {
      const response = await fetch(`${ENDPOINT}/${action}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const data = await response.json().catch(() => ({ ok: false, error: { message: `HTTP ${response.status}` } }))
      if (!response.ok || data.ok === false) {
        const failure = new Error(data?.error?.message ?? `HTTP ${response.status}`)
        failure.code = data?.error?.code
        throw failure
      }
      return data
    }

    /**
     * Turn a host failure into the reader's language. The Host answers with a
     * stable code and an English message; the page prefers the code so the text
     * follows the app language instead of echoing English into a Chinese UI.
     * @param {Error & { code?: string }} error failure from `request`
     * @param {(key: string) => string} t bound translator
     */
    const explain = (error, t) => {
      const key = error?.code === undefined ? '' : `err_${error.code}`
      if (key.length > 0) {
        const text = t(key)
        if (text !== key) return text
      }
      return error?.message ?? String(error)
    }

    const stamp = (iso, t) => {
      if (!iso) return ''
      const date = new Date(iso)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * The whole page. Local state only: roster, last probe, selection, proxy.
     * @param {{ t: (key: string) => string }} props
     */
    function EngineSection({ t }) {
      const [state, setState] = React.useState({ phase: 'loading' })
      const [selected, setSelected] = React.useState(() => new Set())
      const [message, setMessage] = React.useState(null)
      const [proxy, setProxy] = React.useState('')
      const [busy, setBusy] = React.useState(null)
      const [showAll, setShowAll] = React.useState(false)

      const load = React.useCallback(async () => {
        setState({ phase: 'loading' })
        try {
          const data = await request('engines')
          const enabled = new Set(data.engines.filter((engine) => engine.enabled).map((engine) => engine.name))
          setSelected(enabled)
          setProxy(data.proxy ?? '')
          setState({ phase: 'ready', data })
        } catch (error) {
          setState({ phase: 'failed', error: error.message })
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      // Opening the page should not show an empty table: measure the engines the
      // user already has checked, once per mount. Failures stay in the table and
      // in the advice block instead of interrupting the page.
      const autoProbed = React.useRef(false)
      React.useEffect(() => {
        if (state.phase !== 'ready' || autoProbed.current) return
        autoProbed.current = true
        if (state.data.probe !== null) return
        const enabled = state.data.engines.filter((engine) => engine.enabled).map((engine) => engine.name)
        if (enabled.length === 0) return
        probe(enabled)
      }, [state.phase, state.data])

      const scored = new Map()
      for (const result of state.data?.probe?.results ?? []) scored.set(result.name, result)

      const probe = async (targets) => {
        setBusy('probe')
        setMessage(null)
        try {
          const data = await request('probe', targets === undefined ? {} : { engines: targets })
          // A probe only measures. Changing the checkboxes here would undo a
          // deliberate selection (and the automatic probe on open would rewrite
          // it silently); `selectRecommended` is the explicit way to adopt it.
          setState((current) => ({
            ...current,
            data: { ...current.data, probe: { at: data.at, query: data.query, tookMs: data.tookMs, results: data.results } },
          }))
        } catch (error) {
          setMessage({ kind: 'error', text: `${t('errorTitle')}: ${explain(error, t)}` })
        } finally {
          setBusy(null)
        }
      }

      const apply = async () => {
        const engines = [...selected]
        if (engines.length === 0) {
          setMessage({ kind: 'error', text: t('emptySelection') })
          return
        }
        setBusy('apply')
        setMessage(null)
        try {
          const data = await request('apply', { engines })
          setMessage({ kind: 'ok', text: `${t('applied')}: ${data.verified?.join(', ') ?? engines.join(', ')} · ${t('backup')} ${data.backup?.split('/').pop() ?? ''}` })
          await load()
        } catch (error) {
          setMessage({ kind: 'error', text: `${t('errorTitle')}: ${explain(error, t)}` })
        } finally {
          setBusy(null)
        }
      }

      const saveProxy = async (value) => {
        setBusy('proxy')
        setMessage(null)
        try {
          const data = await request('proxy', { url: value })
          setProxy(data.proxy ?? '')
          setMessage({ kind: 'ok', text: data.proxy === null ? t('proxyCleared') : t('proxySaved') })
        } catch (error) {
          setMessage({ kind: 'error', text: `${t('errorTitle')}: ${explain(error, t)}` })
        } finally {
          setBusy(null)
        }
      }

      const toggle = (name) => {
        setSelected((current) => {
          const next = new Set(current)
          if (next.has(name)) next.delete(name)
          else next.add(name)
          return next
        })
      }

      const selectRecommended = () => {
        const recommended = (state.data?.probe?.results ?? []).filter((result) => result.score >= 60).map((result) => result.name)
        if (recommended.length > 0) setSelected(new Set(recommended))
      }

      if (state.phase === 'loading') {
        return h('div', { className: 'sx-page' }, h('div', { className: 'sx-sub' }, t('loading')))
      }
      if (state.phase === 'failed') {
        return h(
          'div',
          { className: 'sx-page' },
          h('div', { className: 'sx-msg', 'data-kind': 'error' }, `${t('errorTitle')}: ${state.error}`),
          h('div', null, h('button', { className: 'sx-btn', onClick: load }, t('refresh'))),
        )
      }

      const data = state.data
      const probeInfo = data.probe
      // The roster is deliberately not the universe: an engine outside it must
      // stay visible and selectable, or a recommendation could never be widened.
      // The roster is deliberately not the universe: an engine outside it must
      // stay visible and selectable, or a recommendation could never be widened.
      const rows = data.engines
        .filter((engine) => showAll || engine.enabled || scored.has(engine.name) || selected.has(engine.name))
        .slice()
        .sort((a, b) => {
          const sa = scored.get(a.name)?.score ?? -1
          const sb = scored.get(b.name)?.score ?? -1
          if (sa !== sb) return sb - sa
          return a.name.localeCompare(b.name)
        })

      // Group by the engine's first category; most engines declare several and
      // the first one is the tab SearXNG itself files them under.
      const GROUP_ORDER = ['general', 'news', 'images', 'videos', 'it', 'science', 'files', 'social media', 'map', 'music']
      const rank = (key) => {
        const index = GROUP_ORDER.indexOf(key)
        return index === -1 ? GROUP_ORDER.length : index
      }
      // The first category is the tab SearXNG files the engine under; later ones
      // are hints (`general` + `web`, `it` + `repos`).
      const groupOf = (engine) => (Array.isArray(engine.categories) && engine.categories.length > 0 ? engine.categories[0] : 'other')
      const categoryLabel = (key) => {
        const label = t(`cat_${key.replace(/[^a-z]+/gi, '_')}`)
        return label.startsWith('cat_') ? key : label
      }

      // Which of the selected engines are worth turning off, and why.
      //
      // Only two facts justify that advice: the engine did not answer (blocked),
      // or it answered too slowly to be useful. Zero results is deliberately NOT
      // advice — the probe asks one short query, so a currency or translation
      // engine legitimately returns nothing in 5 ms while working perfectly.
      const advice = []
      const quiet = []
      for (const engine of data.engines) {
        if (!selected.has(engine.name)) continue
        const result = scored.get(engine.name)
        if (result === undefined) continue
        if (!result.ok) {
          advice.push({ name: engine.name, reason: 'adviceReasonBlocked', detail: result.error })
        } else if (result.latencyMs > 5000) {
          advice.push({ name: engine.name, reason: 'adviceReasonSlow', detail: `${(result.latencyMs / 1000).toFixed(1)} s` })
        } else if (result.results === 0) {
          quiet.push(engine.name)
        }
      }

      const grouped = new Map()
      for (const engine of rows) {
        const key = groupOf(engine)
        if (!grouped.has(key)) grouped.set(key, [])
        grouped.get(key).push(engine)
      }
      const orderedGroups = [...grouped.entries()].sort(
        (a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]),
      )

      return h(
        'div',
        { className: 'sx-page' },
        h(
          'div',
          { className: 'sx-head' },
          h('div', { className: 'sx-title' }, t('title')),
          h('div', { className: 'sx-sub' }, t('subtitle')),
          h(
            'div',
            { className: 'sx-meta' },
            h('span', { title: data.settingsPath }, `${t('settingsAt')}: ${data.settingsPathShort ?? data.settingsPath}`),
          ),
        ),
        h(
          'div',
          { className: 'sx-bar' },
          h('button', { className: 'sx-btn', onClick: probe, disabled: busy !== null }, busy === 'probe' ? t('probing') : t('probe')),
          h('button', { className: 'sx-btn', onClick: selectRecommended, disabled: !probeInfo || busy !== null }, t('selectRecommended')),
          h('button', { className: 'sx-btn', 'data-primary': 'true', onClick: apply, disabled: busy !== null }, busy === 'apply' ? t('applying') : `${t('apply')} (${selected.size})`),
          h('button', { className: 'sx-btn', onClick: load, disabled: busy !== null }, t('refresh')),
          h(
            'label',
            { className: 'sx-note', style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
            h('input', {
              className: 'sx-pick',
              type: 'checkbox',
              checked: showAll,
              onChange: () => setShowAll((value) => !value),
            }),
            `${t('showAll')} (${data.engines.length})`,
          ),
        ),
        probeInfo
          ? h(
              'div',
              { className: 'sx-meta' },
              h('span', null, `${t('lastProbe')}: ${stamp(probeInfo.at, t)}`),
              h('span', null, `“${probeInfo.query}”`),
              h('span', null, `${t('took')} ${probeInfo.tookMs} ms`),
              h('span', null, t('scoreNote')),
            )
          : h('div', { className: 'sx-note' }, t('noProbe')),
        h(
          'div',
          { className: 'sx-table' },
          h(
            'div',
            { className: 'sx-row', 'data-head': 'true' },
            h('span', null, ''),
            h('span', null, t('engine')),
            h('span', null, t('enabled')),
            h('span', { className: 'sx-num' }, t('score')),
            h('span', null, ''),
            h('span', { className: 'sx-num' }, t('latency')),
            h('span', { className: 'sx-num' }, t('results')),
          ),
          ...orderedGroups.flatMap(([key, members]) => [
            h('div', { className: 'sx-group', key: `group-${key}` }, categoryLabel(key), h('span', { className: 'sx-group__count' }, String(members.length))),
            ...members.map((engine) => {
              const result = scored.get(engine.name)
              return h(
                'div',
                { className: 'sx-row', key: engine.name },
                h('input', {
                  className: 'sx-pick',
                  type: 'checkbox',
                  checked: selected.has(engine.name),
                  onChange: () => toggle(engine.name),
                  'aria-label': engine.name,
                }),
                h('span', { className: 'sx-name', title: engine.active === false ? t('notListed') : engine.name }, engine.name),
                h(
                  'span',
                  { className: 'sx-tag', 'data-on': engine.enabled ? 'true' : 'false' },
                  engine.enabled ? t('enabled') : engine.active === false ? t('notListed') : t('disabled'),
                ),
                h('span', { className: 'sx-num' }, result ? String(result.score) : '—'),
                h(
                  'span',
                  { className: 'sx-track', title: result ? `${result.score}` : '' },
                  result ? h('span', { className: 'sx-fill', 'data-low': result.score < 60 ? 'true' : 'false', style: { width: `${result.score}%` } }) : null,
                ),
                h('span', { className: 'sx-num' }, result ? `${result.latencyMs} ms` : '—'),
                h('span', { className: 'sx-num' }, result ? String(result.results) : '—'),
              )
            }),
          ]),
        ),
        probeInfo
          ? h(
              'div',
              { className: 'sx-box' },
              h(
                'div',
                { className: 'sx-box__head' },
                t('adviceTitle'),
                advice.length === 0 ? null : h('span', { className: 'sx-group__count' }, String(advice.length)),
              ),
              advice.length === 0
                ? h('div', { className: 'sx-note' }, t('adviceAllGood'))
                : h(
                    'div',
                    { className: 'sx-advice' },
                    ...advice.map((item) =>
                      h(
                        'div',
                        { className: 'sx-advice__row', key: item.name },
                        h('span', { className: 'sx-name' }, item.name),
                        h('span', { className: 'sx-note' }, `${t('adviceOff')} · ${t(item.reason)}${item.detail ? ` (${item.detail})` : ''}`),
                      ),
                    ),
                  ),
              quiet.length === 0
                ? null
                : h('div', { className: 'sx-note' }, `${t('adviceQuiet')}: ${quiet.join(', ')}`),
              advice.length === 0
                ? null
                : h(
                    'button',
                    {
                      className: 'sx-btn',
                      onClick: () => {
                        const bad = new Set(advice.map((item) => item.name))
                        setSelected(new Set([...selected].filter((name) => !bad.has(name))))
                      },
                    },
                    t('adviceApply'),
                  ),
            )
          : busy === 'probe'
            ? h('div', { className: 'sx-note' }, t('autoTesting'))
            : null,
        h(
          'div',
          { className: 'sx-box' },
          h('div', { className: 'sx-box__head' }, t('proxyTitle')),
          h('div', { className: 'sx-note' }, t('proxyHint')),
          h(
            'div',
            { className: 'sx-field' },
            h('input', {
              className: 'sx-input',
              value: proxy,
              placeholder: t('proxyPlaceholder'),
              spellCheck: 'false',
              onChange: (event) => setProxy(event.target.value),
            }),
            h('button', { className: 'sx-btn', onClick: () => saveProxy(proxy), disabled: busy !== null }, busy === 'proxy' ? t('saving') : t('save')),
            h('button', { className: 'sx-btn', onClick: () => saveProxy(''), disabled: busy !== null || proxy.length === 0 }, t('clear')),
          ),
        ),
        message ? h('div', { className: 'sx-msg', 'data-kind': message.kind }, message.text) : null,
        h('div', { className: 'sx-note' }, t('bugHint')),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'searxng-search: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = 'dsh-searxng-search'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'searxng-search: styles')

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'searxng-search',
              order: 31,
              label: () => t('nav'),
              locale: NS,
              inject: () => ({ t }),
            },
            EngineSection,
          ),
        )
      },
    }
  },
})
