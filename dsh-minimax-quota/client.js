/**
 * MiniMax quota monitor — browser half.
 *
 * Registers a reading in the `conversation.composer.dock` slot, directly under
 * the message composer. The reading shows the remaining percentage of the
 * MiniMax window, a progress bar that shifts from green to amber to red, and
 * the time left before the window resets. Hovering it shows the details the
 * upstream API provides.
 *
 * The reading belongs to MiniMax sessions only. `conversation.composer.dock`
 * is a Session-scoped slot, so its `inject` callback receives the Session id;
 * the entry resolves that Session's `modelSelection` projection once and the
 * component subscribes to it. Switching to another model re-renders the entry
 * and removes the reading, its route polling and its notifications.
 *
 * The browser never sees the MiniMax API key: it reads the Host's cached
 * snapshot over a loopback-only route and polls that route instead of the
 * upstream endpoint.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-minimax-quota',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace of this plugin's own copy. */
    const NAMESPACE = 'minimaxQuota'

    /** The Host's loopback route serving the cached snapshot. */
    const ROUTE = '/api/minimax-quota/remains'

    /** How often the browser reads the Host's snapshot. */
    const POLL_MS = 15_000

    /** How often the countdown is re-rendered. */
    const TICK_MS = 20_000

    /**
     * Provider and model identifiers that identify a MiniMax route. DSH reports
     * the provider id configured for the route (for example `minimax-cn`); a
     * model reached through an aggregator carries the name in the model id.
     */
    const MINIMAX_ID = /minimax/i

    /**
     * @param {unknown} selection - one selection (`{ provider, model }`).
     * @returns {boolean} whether it routes to a MiniMax model.
     */
    function isMiniMaxSelection(selection) {
      if (!selection || typeof selection !== 'object') return false
      const provider = typeof selection.provider === 'string' ? selection.provider : ''
      const model = typeof selection.model === 'string' ? selection.model : ''
      return MINIMAX_ID.test(provider) || MINIMAX_ID.test(model)
    }

    /**
     * @param {unknown} projection - the session's `modelSelection` projection.
     * @returns {Record<string, unknown> | undefined} the next/last selected model.
     */
    function currentSelection(projection) {
      if (!projection || typeof projection !== 'object') return undefined
      return projection.next ?? projection.lastUsed
    }

    /**
     * Resolve the Session's `modelSelection` projection as an observable face.
     *
     * The dock slot is Session-scoped: its `inject` callback receives the
     * Session id. The same projection feeds the composer's model seat, so a
     * switch made there is visible here on the next update.
     *
     * @param {object} ctx - the browser half's plugin context.
     * @param {string} sessionId - the Session that owns the composer.
     * @returns {{ getSnapshot: () => unknown, subscribe: (listener: () => void) => () => void } | undefined} the face.
     */
    function modelSelectionFace(ctx, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      try {
        const binding = ctx.sessions?.binding?.(sessionId)
        const projections = binding?.session?.projections
        if (!projections || typeof projections.faceOf !== 'function') return undefined
        const face = projections.faceOf('modelSelection')
        if (!face || typeof face.getSnapshot !== 'function' || typeof face.subscribe !== 'function') {
          return undefined
        }
        return face
      } catch {
        // A Session that is still assembling has no projection yet; the entry
        // stays hidden until the binding publishes one.
        return undefined
      }
    }

    /**
     * Subscribe to the Session's model-selection face.
     *
     * An absent face still calls the same hooks in the same order, so a
     * Session whose projection arrives late never changes the hook shape.
     *
     * @param {{ getSnapshot: () => unknown, subscribe: (listener: () => void) => () => void } | undefined} face - the observable face.
     * @returns {unknown} the current projection snapshot.
     */
    function useModelSelection(face) {
      const subscribe = React.useCallback(
        (onChange) => {
          if (!face || typeof face.subscribe !== 'function') return () => {}
          try {
            return face.subscribe(onChange)
          } catch {
            return () => {}
          }
        },
        [face],
      )
      const getSnapshot = React.useCallback(() => {
        if (!face || typeof face.getSnapshot !== 'function') return undefined
        try {
          return face.getSnapshot()
        } catch {
          return undefined
        }
      }, [face])
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    const EN = {
      label: 'MiniMax 5h',
      remaining: 'remaining',
      exhausted: 'quota exhausted, resets at',
      resetsIn: 'resets in {duration}',
      unknown: 'unknown',
      unavailable: 'unavailable',
      region: 'region',
      bucket: 'quota bucket',
      window: 'window',
      weekly: 'weekly window',
      quota: 'quota',
      used: 'used',
      total: 'total',
      updatedAt: 'updated at',
      alertTitle: 'MiniMax quota is running low',
      alertBody: 'Only {percent}% of the {label} quota is left.',
    }

    const ZH = {
      label: 'MiniMax 5h',
      remaining: '剩余',
      exhausted: '额度耗尽，预计',
      resetsIn: '{duration} 后重置',
      unknown: '未知',
      unavailable: '不可用',
      region: '区域',
      bucket: '额度桶',
      window: '窗口',
      weekly: '周窗口',
      quota: '配额',
      used: '已用',
      total: '总量',
      updatedAt: '更新于',
      alertTitle: 'MiniMax 额度即将耗尽',
      alertBody: '{label} 配额仅剩 {percent}%。',
    }

    /**
     * Resolve a key in a flat dictionary, substituting `{name}` placeholders.
     *
     * @param {Record<string, string>} dictionary - the dictionary to read.
     * @param {string} key - the key.
     * @param {Record<string, string | number>} [params] - placeholder values.
     * @returns {string} the resolved copy.
     */
    function interpolate(dictionary, key, params) {
      const template = dictionary[key] ?? key
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.hasOwn(params, name) ? String(params[name]) : match,
      )
    }

    /**
     * Format a duration as a compact `1h 23m` reading.
     *
     * @param {number} ms - the duration in milliseconds.
     * @returns {string} the formatted duration.
     */
    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '—'
      if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
      const totalMinutes = Math.floor(ms / 60_000)
      const days = Math.floor(totalMinutes / 1440)
      const hours = Math.floor((totalMinutes % 1440) / 60)
      const minutes = totalMinutes % 60
      if (days > 0) return `${days}d ${hours}h`
      if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
      return `${minutes}m`
    }

    /**
     * Format an epoch timestamp as a local `HH:MM` clock reading.
     *
     * @param {number} epochMs - the timestamp.
     * @returns {string} the formatted clock reading.
     */
    function formatClock(epochMs) {
      if (!Number.isFinite(epochMs)) return '—'
      const date = new Date(epochMs)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * Raise one desktop notification per window when the quota runs low.
     *
     * @param {Record<string, unknown>} doc - the Host snapshot.
     * @param {(key: string, params?: Record<string, string | number>) => string} t - the translator.
     */
    function maybeNotify(doc, t) {
      if (!doc || doc.ok !== true) return
      const percent = doc.remainingPercent
      if (typeof percent !== 'number' || percent > 10) return
      const key = `minimax-quota-alert-${doc.resetAt ?? 0}`
      try {
        if (window.sessionStorage.getItem(key)) return
        window.sessionStorage.setItem(key, '1')
      } catch {
        return
      }
      const title = t('alertTitle')
      const body = t('alertBody', {
        percent: String(Math.round(percent)),
        label: String(doc.label ?? EN.label),
      })
      try {
        if (typeof Notification === 'undefined') return
        if (Notification.permission === 'granted') {
          new Notification(title, { body, tag: key })
        } else if (Notification.permission === 'default') {
          Notification.requestPermission()
            .then((permission) => {
              if (permission === 'granted') new Notification(title, { body, tag: key })
            })
            .catch(() => {})
        }
      } catch {
        // Notifications are best-effort; the status line carries the warning.
      }
    }

    /**
     * Build the status-line component bound to one translator.
     *
     * @param {(key: string, params?: Record<string, string | number>) => string} fallback - the translator used when the host supplies none.
     * @returns {React.FunctionComponent} the component.
     */
    function createQuotaIndicator(fallback) {
      /**
       * @param {{
       *   translate?: (key: string, params?: Record<string, string | number>) => string,
       *   modelSelection?: (() => { getSnapshot: () => unknown, subscribe: (listener: () => void) => () => void } | undefined)
       *     | { getSnapshot: () => unknown, subscribe: (listener: () => void) => () => void },
       * }} props - the slot props; `modelSelection` resolves the face the registration's `inject` prepared.
       * @returns {React.ReactElement | null} the reading, or nothing when the session uses another model.
       */
      function QuotaIndicator(props) {
        const t = typeof props.translate === 'function' ? props.translate : fallback
        // `modelSelection` is the same projection the composer's model seat
        // reads, so a switch is reflected as soon as the projection updates.
        // Resolving it per render lets a Session whose projection arrives a
        // beat late recover without waiting for the binding to change.
        const face =
          typeof props.modelSelection === 'function'
            ? props.modelSelection()
            : props.modelSelection
        const projection = useModelSelection(face)
        const minimax = isMiniMaxSelection(currentSelection(projection))
        const [doc, setDoc] = React.useState(undefined)
        const [now, setNow] = React.useState(() => Date.now())

        React.useEffect(() => {
          if (!minimax) {
            setDoc(undefined)
            return undefined
          }
          let cancelled = false
          const load = async () => {
            try {
              const response = await fetch(ROUTE, { headers: { accept: 'application/json' } })
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              const body = await response.json()
              if (cancelled) return
              setDoc(body)
              maybeNotify(body, t)
            } catch (error) {
              if (cancelled) return
              setDoc({ ok: false, error: String(error?.message ?? error) })
            }
          }
          void load()
          const timer = setInterval(() => {
            void load()
          }, POLL_MS)
          return () => {
            cancelled = true
            clearInterval(timer)
          }
        }, [t, minimax])

        React.useEffect(() => {
          if (!minimax) return undefined
          const timer = setInterval(() => setNow(Date.now()), TICK_MS)
          return () => clearInterval(timer)
        }, [minimax])

        // The reading belongs to MiniMax sessions only. Returning before the
        // markup is built means another model leaves the composer dock empty.
        if (!minimax) return null

        const ok = doc?.ok === true
        const percent = ok && typeof doc.remainingPercent === 'number' ? doc.remainingPercent : null
        const warnPercent = typeof doc?.warnPercent === 'number' ? doc.warnPercent : 30
        const criticalPercent = typeof doc?.criticalPercent === 'number' ? doc.criticalPercent : 10
        const label = String(doc?.label ?? t('label'))

        let resetsInMs = null
        if (ok) {
          if (Number.isFinite(doc.resetAt)) resetsInMs = Math.max(0, doc.resetAt - now)
          else if (Number.isFinite(doc.resetsInMs)) resetsInMs = Math.max(0, doc.resetsInMs - (Date.now() - doc.updatedAt))
        }

        let tone = 'idle'
        if (!ok) tone = 'error'
        else if (percent !== null) {
          if (percent <= criticalPercent) tone = 'error'
          else if (percent <= warnPercent) tone = 'warn'
          else tone = 'ok'
        }

        const percentText = percent === null ? '—' : `${Math.round(percent)}%`
        const exhausted = ok && percent !== null && percent <= 0

        const detail = !ok
          ? `${label}: ${doc?.error ?? t('unavailable')}`
          : [
              `${label} — ${t('remaining')} ${percent === null ? t('unknown') : `${Math.round(percent)}%`}`,
              `${t('region')}: ${doc.region ?? '—'}`,
              `${t('bucket')}: ${doc.bucket ?? '—'}`,
              Number.isFinite(doc.windowMs) ? `${t('window')}: ${formatDuration(doc.windowMs)}` : null,
              Number.isFinite(doc.totalCount) && Number.isFinite(doc.usageCount)
                ? `${t('quota')}: ${t('used')} ${doc.usageCount} / ${t('total')} ${doc.totalCount}`
                : null,
              Number.isFinite(doc.weeklyRemainingPercent)
                ? `${t('weekly')}: ${Math.round(doc.weeklyRemainingPercent)}%`
                : null,
              Number.isFinite(doc.resetAt)
                ? `${t('resetsIn', { duration: formatDuration(resetsInMs ?? 0) })} (${formatClock(doc.resetAt)})`
                : null,
              `${t('updatedAt')}: ${formatClock(doc.updatedAt)}`,
            ]
              .filter(Boolean)
              .join('\n')

        return h(
          React.Fragment,
          null,
          h('style', { dangerouslySetInnerHTML: { __html: STYLE } }),
          h(
            'span',
            { className: 'mmq', title: detail, 'data-minimax-quota': tone },
            h(
              'span',
              { className: 'mmq-bar' },
              h('span', {
                className: 'mmq-fill',
                style: { width: `${percent === null ? 0 : Math.min(100, Math.max(0, percent))}%` },
              }),
            ),
            h('span', { className: 'mmq-label' }, label),
            h('span', { className: 'mmq-percent' }, percentText),
            exhausted && Number.isFinite(doc.resetAt)
              ? h('span', { className: 'mmq-reset' }, ` · ${t('exhausted')} ${formatClock(doc.resetAt)}`)
              : null,
            !exhausted && resetsInMs !== null
              ? h('span', { className: 'mmq-reset' }, ` · ${t('resetsIn', { duration: formatDuration(resetsInMs) })}`)
              : null,
            tone === 'error' && percent !== null
              ? h('span', { className: 'mmq-warn', 'aria-label': 'warning' }, ' ⚠')
              : null,
          ),
        )
      }
      return QuotaIndicator
    }

    const STYLE = [
      '.mmq{display:inline-flex;align-items:center;gap:6px;font-size:11px;line-height:16px;',
      'font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dsw-alias-label-secondary);}',
      '.mmq-bar{display:inline-block;width:52px;height:6px;border-radius:999px;overflow:hidden;',
      'background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);}',
      '.mmq-fill{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-state-success-primary);',
      'transition:width 300ms ease;}',
      '.mmq[data-minimax-quota="warn"] .mmq-fill{background:var(--dsw-alias-state-warn-primary);}',
      '.mmq[data-minimax-quota="error"] .mmq-fill{background:var(--dsw-alias-state-error-primary);}',
      '.mmq[data-minimax-quota="idle"] .mmq-fill{background:var(--dsw-alias-state-idle-primary);}',
      '.mmq-label{color:var(--dsw-alias-label-dimmed);}',
      '.mmq-percent{color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.mmq-reset{color:var(--dsw-alias-label-dimmed);}',
      '.mmq-warn{color:var(--dsw-alias-state-error-primary);}',
    ].join('')

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        let translate = (key, params) => interpolate(EN, key, params)
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            ctx.effect(
              () => ctx.locale.register(NAMESPACE, { en: EN, zh: ZH }),
              'minimax-quota: dictionaries',
            )
          }
          if (ctx.locale && typeof ctx.locale.bind === 'function') {
            translate = ctx.locale.bind(NAMESPACE)
          }
        } catch {
          // A host without the locale service still gets readable English copy.
        }

        const QuotaIndicator = createQuotaIndicator(translate)
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'minimax-quota',
              order: 20,
              // The dock is Session-scoped, so the framework passes the
              // Session id. Return a resolver rather than the face itself:
              // inject results are cached per binding, and resolving at render
              // time lets a projection that arrives late still be picked up.
              inject: (sessionId) => ({
                translate,
                modelSelection: () => modelSelectionFace(ctx, sessionId),
              }),
            },
            QuotaIndicator,
          ),
        )
      },
    }
  },
})
