/**
 * Smoke test for the MiniMax quota plugin's Host half.
 *
 * Runs the real `apply()` against a mock Cordis context, lets it poll the
 * live MiniMax endpoint with the key stored in the Host credential file, and
 * asserts the snapshot the browser half would receive.
 *
 * Run: node tools/host-smoke.mjs
 */
import { readFile } from 'node:fs/promises'
import { apply } from '../dsh-minimax-quota/index.js'

const CREDS = 'C:\\Users\\nkb\\.dsh\\.credentials.yaml'

function readRef(text, name) {
  const match = text.match(new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, 'm'))
  if (!match) return undefined
  let value = match[1].trim()
  if (value.length >= 2 && value[0] === value[1] && (value[0] === '"' || value[0] === "'")) {
    value = value.slice(1, -1)
  }
  return value
}

const credsText = await readFile(CREDS, 'utf8')
const apiKey = readRef(credsText, 'MINIMAX_CN_API_KEY')
if (!apiKey) throw new Error('MINIMAX_CN_API_KEY is not in the credential store')

let route = undefined
const disposers = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  get(name) {
    if (name === 'credentials') {
      return { resolve: async (ref) => (ref === 'MINIMAX_CN_API_KEY' ? { value: apiKey, source: 'file' } : undefined) }
    }
    if (name === 'settings') {
      return { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY' } } } }] }
    }
    return undefined
  },
  webServer: {
    register(definition) {
      route = definition
      return () => {}
    },
  },
  logger: { warn() {}, error() {} },
}

apply(ctx, {
  apiKeyEnv: 'MINIMAX_CN_API_KEY',
  region: 'CN',
  pollIntervalMs: 60000,
  bucket: 'general',
  label: 'MiniMax 5h',
  warnPercent: 30,
  criticalPercent: 10,
})

if (!route) throw new Error('the Host half registered no route')

// Let the first poll finish.
await new Promise((resolve) => setTimeout(resolve, 4000))

let body
const res = {
  headers: {},
  writeHead(status, headers) {
    this.status = status
    this.headers = headers
  },
  end(chunk) {
    body = chunk
  },
}
route.handler({ method: 'GET', headers: { host: '127.0.0.1:12137', origin: 'http://127.0.0.1:12137' }, socket: { remoteAddress: '127.0.0.1' } }, res)

const doc = JSON.parse(body)
console.log('route:', route.kind, route.path)
console.log('status:', res.status)
console.log(JSON.stringify(doc, null, 2))

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

check('the snapshot is ok', doc.ok === true, doc.error)
check('a region is reported', typeof doc.region === 'string' && doc.region.length > 0, String(doc.region))
check('the bucket is the configured one', doc.bucket === 'general', String(doc.bucket))
check('a remaining percentage is present', typeof doc.remainingPercent === 'number', String(doc.remainingPercent))
check('the percentage is in range', doc.remainingPercent >= 0 && doc.remainingPercent <= 100, String(doc.remainingPercent))
check('the percentage came from the percent field', doc.percentSource === 'percent', String(doc.percentSource))
check('a reset time is present', typeof doc.resetAt === 'number' && doc.resetAt > 0, String(doc.resetAt))
check('a countdown is present', typeof doc.resetsInMs === 'number' && doc.resetsInMs >= 0, String(doc.resetsInMs))
check('the window length is present', typeof doc.windowMs === 'number' && doc.windowMs > 0, String(doc.windowMs))
check('the label is carried through', doc.label === 'MiniMax 5h', String(doc.label))
check('the thresholds are carried through', doc.warnPercent === 30 && doc.criticalPercent === 10)

// A non-loopback peer must be refused.
let forbidden = false
route.handler({ method: 'GET', headers: { host: '127.0.0.1:12137' }, socket: { remoteAddress: '10.0.0.5' } }, {
  writeHead(status) { forbidden = status === 403 },
  end() {},
})
check('a non-loopback peer is refused', forbidden)

for (const dispose of disposers) dispose()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
