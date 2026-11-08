/**
 * Renders the MiniMax quota plugin's real browser half for every status, so
 * the visual result can be inspected without touching a live profile.
 *
 * The harness loads `client.js` exactly as the browser's module table does
 * (`window.__ModuleLoader__.load`), captures the registered slot component,
 * and renders it through a minimal React stand-in that seeds the component's
 * state with a synthetic Host snapshot.
 *
 * Run: node tools/client-render.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const CLIENT = resolve(root, 'dsh-minimax-quota', 'client.js')
const OUT = resolve(root, 'docs', 'states.html')

/* ------------------------------------------------------------------ *
 * Capture the module the way the browser's module table does.
 * ------------------------------------------------------------------ */
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
}
globalThis.sessionStorage = {
  store: new Map(),
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null
  },
  setItem(key, value) {
    this.store.set(key, value)
  },
}
await import(`file://${CLIENT.replace(/\\/g, '/')}`)

if (!captured) throw new Error('client.js did not call window.__ModuleLoader__.load')
if (captured.id !== '@local/dsh-minimax-quota') throw new Error(`unexpected module id ${captured.id}`)

/* ------------------------------------------------------------------ *
 * A minimal React stand-in: enough for createElement, Fragment and the
 * two state hooks the component uses.
 * ------------------------------------------------------------------ */
const FRAGMENT = Symbol('Fragment')

function makeReact(seed) {
  const queue = [...seed]
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(6) }
    },
    Fragment: FRAGMENT,
    useState(initial) {
      const value = queue.length > 0 ? queue.shift() : typeof initial === 'function' ? initial() : initial
      return [value, () => {}]
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
  }
}

/* ------------------------------------------------------------------ *
 * A Session binding stand-in exposing the modelSelection projection the
 * way the running Harness does: the dock entry's `inject(sessionId)` path
 * resolves `sessions.binding(id).session.projections.faceOf(name)`.
 * ------------------------------------------------------------------ */
function faceOfSelection(selection) {
  const snapshot = selection === undefined ? undefined : selection
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
  }
}

/* ------------------------------------------------------------------ *
 * A Host context stand-in capturing the slot registration.
 * ------------------------------------------------------------------ */
let dictionaries = {}
let injectedSlot = null
const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  slots: {
    inject(name, callback) {
      injectedSlot = name
      const disposer = callback()
      return () => (typeof disposer === 'function' ? disposer() : undefined)
    },
    register(options, component) {
      registered = { name: injectedSlot, options, component }
      return () => {}
    },
  },
  locale: {
    register(namespace, dicts) {
      dictionaries = dicts
      return () => {}
    },
    bind() {
      return (key, params) => {
        const template = dictionaries?.en?.[key] ?? key
        if (!params) return template
        return template.replace(/\{(\w+)\}/g, (match, name) =>
          Object.hasOwn(params, name) ? String(params[name]) : match,
        )
      }
    },
  },
}

/* ------------------------------------------------------------------ *
 * Serialize the element tree to HTML.
 * ------------------------------------------------------------------ */
const escapeHtml = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function styleToCss(style) {
  return Object.entries(style)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${value}`)
    .join(';')
}

function render(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(render).join('')
  if (node.type === FRAGMENT) return node.children.map(render).join('')
  const { type, props, children } = node
  const attributes = []
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || key === 'dangerouslySetInnerHTML') continue
    if (value === null || value === undefined || value === false) continue
    if (key === 'className') attributes.push(`class="${escapeHtml(value)}"`)
    else if (key === 'style') attributes.push(`style="${escapeHtml(styleToCss(value))}"`)
    else attributes.push(`${key}="${escapeHtml(value)}"`)
  }
  const inner = props.dangerouslySetInnerHTML?.__html ?? children.map(render).join('')
  return `<${type}${attributes.length ? ' ' + attributes.join(' ') : ''}>${inner}</${type}>`
}

/* ------------------------------------------------------------------ *
 * Render every status.
 * ------------------------------------------------------------------ */
const NOW = Date.UTC(2026, 10, 8, 13, 30, 0)
const minute = 60_000

const states = [
  {
    key: 'healthy',
    caption: 'Healthy — 62% left (green)',
    selection: { next: { provider: 'minimax-cn', model: 'MiniMax-M2' } },
    doc: {
      ok: true,
      region: 'CN',
      label: 'MiniMax 5h',
      bucket: 'general',
      remainingPercent: 62,
      percentSource: 'percent',
      totalCount: 0,
      usageCount: 0,
      weeklyRemainingPercent: 100,
      resetAt: NOW + 83 * minute,
      resetsInMs: 83 * minute,
      windowMs: 240 * minute,
      warnPercent: 30,
      criticalPercent: 10,
      updatedAt: NOW,
    },
  },
  {
    key: 'warning',
    caption: 'Warning — 22% left (amber)',
    selection: { next: { provider: 'minimax-cn', model: 'MiniMax-M2' } },
    doc: {
      ok: true,
      region: 'CN',
      label: 'MiniMax 5h',
      bucket: 'general',
      remainingPercent: 22,
      percentSource: 'percent',
      totalCount: 0,
      usageCount: 0,
      weeklyRemainingPercent: 100,
      resetAt: NOW + 12 * minute,
      resetsInMs: 12 * minute,
      windowMs: 240 * minute,
      warnPercent: 30,
      criticalPercent: 10,
      updatedAt: NOW,
    },
  },
  {
    key: 'critical',
    caption: 'Critical — 7% left (red, warning mark)',
    selection: { next: { provider: 'minimax-cn', model: 'MiniMax-M2' } },
    doc: {
      ok: true,
      region: 'CN',
      label: 'MiniMax 5h',
      bucket: 'general',
      remainingPercent: 7,
      percentSource: 'percent',
      totalCount: 0,
      usageCount: 0,
      weeklyRemainingPercent: 100,
      resetAt: NOW + 5 * minute,
      resetsInMs: 5 * minute,
      windowMs: 240 * minute,
      warnPercent: 30,
      criticalPercent: 10,
      updatedAt: NOW,
    },
  },
  {
    key: 'exhausted',
    caption: 'Exhausted — 0% left',
    selection: { next: { provider: 'minimax-cn', model: 'MiniMax-M2' } },
    doc: {
      ok: true,
      region: 'CN',
      label: 'MiniMax 5h',
      bucket: 'general',
      remainingPercent: 0,
      percentSource: 'percent',
      totalCount: 0,
      usageCount: 0,
      weeklyRemainingPercent: 100,
      resetAt: NOW + 2 * minute,
      resetsInMs: 2 * minute,
      windowMs: 240 * minute,
      warnPercent: 30,
      criticalPercent: 10,
      updatedAt: NOW,
    },
  },
  {
    key: 'unavailable',
    caption: 'Unavailable — the Host could not read the quota',
    selection: { next: { provider: 'minimax-cn', model: 'MiniMax-M2' } },
    doc: { ok: false, error: 'no MiniMax API key found for "MINIMAX_CN_API_KEY"', updatedAt: NOW },
  },
  {
    key: 'deepseek',
    caption: 'Hidden — the session uses a DeepSeek model',
    selection: { next: { provider: 'deepseek', model: 'deepseek-chat' } },
    doc: {
      ok: true,
      region: 'CN',
      label: 'MiniMax 5h',
      bucket: 'general',
      remainingPercent: 62,
      percentSource: 'percent',
      totalCount: 0,
      usageCount: 0,
      weeklyRemainingPercent: 100,
      resetAt: NOW + 83 * minute,
      resetsInMs: 83 * minute,
      windowMs: 240 * minute,
      warnPercent: 30,
      criticalPercent: 10,
      updatedAt: NOW,
    },
  },
  {
    key: 'no-selection',
    caption: 'Hidden — no model has been selected yet',
    doc: { ok: true, remainingPercent: 62, updatedAt: NOW },
  },
  {
    key: 'last-used',
    caption: 'Visible — the Session last used a MiniMax model',
    selection: { lastUsed: { provider: 'minimax-cn', model: 'MiniMax-M2' } },
    doc: {
      ok: true,
      region: 'CN',
      label: 'MiniMax 5h',
      bucket: 'general',
      remainingPercent: 48,
      percentSource: 'percent',
      totalCount: 0,
      usageCount: 0,
      weeklyRemainingPercent: 100,
      resetAt: NOW + 40 * minute,
      resetsInMs: 40 * minute,
      windowMs: 240 * minute,
      warnPercent: 30,
      criticalPercent: 10,
      updatedAt: NOW,
    },
  },
  {
    key: 'aggregator-minimax',
    caption: 'Visible — MiniMax reached through an aggregator model id',
    selection: { next: { provider: 'openrouter', model: 'minimax/minimax-m2' } },
    doc: {
      ok: true,
      region: 'GLOBAL',
      label: 'MiniMax 5h',
      bucket: 'general',
      remainingPercent: 48,
      percentSource: 'percent',
      totalCount: 0,
      usageCount: 0,
      weeklyRemainingPercent: 100,
      resetAt: NOW + 40 * minute,
      resetsInMs: 40 * minute,
      windowMs: 240 * minute,
      warnPercent: 30,
      criticalPercent: 10,
      updatedAt: NOW,
    },
  },
]

const rendered = states.map((state) => {
  const React = makeReact([state.doc, NOW])
  // Each state gets its own module instance so the React stand-in can seed
  // that state's snapshot into the component's first render.
  let entry = null
  let slotName = null
  const sessionId = `session-${state.key}`
  const localCtx = {
    ...ctx,
    sessions: {
      binding(id) {
        if (id !== sessionId) return undefined
        return {
          session: {
            projections: {
              faceOf(name) {
                if (name !== 'modelSelection') throw new Error(`unexpected projection ${name}`)
                return faceOfSelection(state.selection)
              },
            },
          },
        }
      },
    },
    slots: {
      inject(name, callback) {
        slotName = name
        callback()
        return () => {}
      },
      register(options, component) {
        entry = { name: slotName, options, component }
        return () => {}
      },
    },
  }
  const fresh = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected module request: ${name}`)
  })
  fresh.apply(localCtx)
  if (!entry) throw new Error(`state ${state.key} registered no entry`)
  if (typeof entry.options.inject !== 'function') {
    throw new Error(`state ${state.key} registered no inject callback`)
  }
  const props = entry.options.inject(sessionId)
  const tree = entry.component(props)
  return { ...state, html: render(tree), slot: entry.name, options: entry.options, props }
})

console.log('slot:', rendered[0].slot)
console.log('entry id:', rendered[0].options.id)
console.log('order:', rendered[0].options.order)

/* ------------------------------------------------------------------ *
 * Assertions over the rendered markup.
 * ------------------------------------------------------------------ */
let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const byKey = Object.fromEntries(rendered.map((item) => [item.key, item.html]))
check('healthy state is green', /data-minimax-quota="ok"/.test(byKey.healthy))
check('warning state is amber', /data-minimax-quota="warn"/.test(byKey.warning))
check('critical state is red', /data-minimax-quota="error"/.test(byKey.critical))
check('unavailable state is red', /data-minimax-quota="error"/.test(byKey.unavailable))
check('the healthy bar is 62% wide', /width:62%/.test(byKey.healthy))
check('the warning bar is 22% wide', /width:22%/.test(byKey.warning))
check('the critical bar is 7% wide', /width:7%/.test(byKey.critical))
check('the healthy reading shows the percentage', byKey.healthy.includes('62%'))
check('the warning reading shows the percentage', byKey.warning.includes('22%'))
check('the critical reading shows the warning mark', byKey.critical.includes('⚠'))
check('the healthy reading shows the countdown', /1h 23m/.test(byKey.healthy))
check('the warning reading shows the countdown', /12m/.test(byKey.warning))
const exhaustedResetClock = (() => {
  const date = new Date(NOW + 2 * minute)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
})()
check('the exhausted reading announces the exhaustion', /quota exhausted, resets at/.test(byKey.exhausted))
check(
  'the exhausted reading shows the reset clock',
  byKey.exhausted.includes(`quota exhausted, resets at ${exhaustedResetClock}`),
  `expected the local clock ${exhaustedResetClock}`,
)
check('the unavailable reading shows the error', byKey.unavailable.includes('no MiniMax API key found'))
check('the reading is hidden for a DeepSeek session', byKey.deepseek === '', byKey.deepseek)
check('the reading is hidden before a model is selected', byKey['no-selection'] === '', byKey['no-selection'])
check(
  'the entry resolves the Session modelSelection face through inject(sessionId)',
  typeof rendered[0].props.modelSelection === 'function' &&
    typeof rendered[0].props.modelSelection()?.getSnapshot === 'function' &&
    rendered[0].props.modelSelection().getSnapshot() !== undefined,
)
check(
  'the reading is visible for a Session whose last model was MiniMax',
  /data-minimax-quota="ok"/.test(byKey['last-used']),
  byKey['last-used'],
)
check(
  'the reading is visible when the model id names MiniMax through another provider',
  /data-minimax-quota="ok"/.test(byKey['aggregator-minimax']),
  byKey['aggregator-minimax'],
)
const visible = rendered.filter((item) => item.html !== '')
check('every visible reading carries a detail tooltip', visible.every((item) => /title="/.test(item.html)))
check('only the model-gated cases render a reading', rendered.length - visible.length === 2)
check('the plugin stylesheet is rendered by the component', byKey.healthy.includes('.mmq[data-minimax-quota="warn"]'))

/* ------------------------------------------------------------------ *
 * Write the preview page.
 * ------------------------------------------------------------------ */
const theme = await readFile(resolve(root, 'docs', 'theme.css'), 'utf8')
const sections = rendered
  .map(
    (item) => `<section><h2>${escapeHtml(item.caption)}</h2>
<div class="dock">${item.html || '<span class="hidden-note">nothing is rendered for this session</span>'}</div>
<pre>${escapeHtml(item.html.replace(/<style[\s\S]*?<\/style>/, '').trim() || '(empty)')}</pre></section>`,
  )
  .join('\n')

await mkdir(dirname(OUT), { recursive: true })
await writeFile(
  OUT,
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>MiniMax quota — status line states</title>
<style>
${theme}
body { margin: 0; padding: 24px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
       font-family: "Segoe UI", system-ui, sans-serif; }
h2 { font-size: 13px; font-weight: 600; margin: 0 0 8px; color: var(--dsw-alias-label-secondary); }
section { margin-bottom: 26px; }
 .dock { display: flex; align-items: center; gap: 14px; padding: 12px 14px; border-radius: 10px;
         background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
         border: 1px solid var(--dsw-alias-border-l1); font-size: 12px; }
 .hidden-note { color: var(--dsw-alias-label-dimmed); font-style: italic; }
pre { font-size: 10px; color: var(--dsw-alias-label-dimmed); white-space: pre-wrap; margin: 6px 0 0; }
</style></head>
<body>
${sections}
</body></html>`,
  'utf8',
)
console.log('\nwrote', OUT)
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
