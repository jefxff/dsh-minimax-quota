/**
 * MiniMax quota monitor — Host half.
 *
 * Polls MiniMax's Token Plan "remains" endpoint for the current window and
 * publishes the snapshot to the browser half over a loopback-only route. The
 * browser half renders it in the `conversation.composer.dock` slot, so the
 * remaining quota is visible without the user doing anything.
 *
 * The API key never reaches the browser: it is resolved here, per request,
 * from the Host credential store (which also layers the process environment),
 * so a rotated key applies on the next poll without a restart.
 *
 * Upstream shape notes (verified against the live endpoint):
 *  - `current_interval_total_count` and `current_interval_usage_count` are
 *    frequently reported as `0`, so they cannot be relied on. The percentage
 *    field `current_interval_remaining_percent` is the authoritative signal
 *    and is used whenever it is present.
 *  - `current_interval_usage_count` has been observed with two readings
 *    across MiniMax deployments: the amount consumed, and the amount left.
 *    A value larger than the total cannot be a consumption count, so it is
 *    read as the remainder; anything at or below the total is read as
 *    consumption. The reading that was applied is reported as
 *    `percentSource`.
 *  - `remains_time` is the remaining milliseconds of the interval;
 *    `end_time` is the absolute end of the window. They normally agree.
 */

export const inject = ['webServer']

/** One upstream origin per MiniMax region. */
const REGION_ORIGINS = {
  CN: 'https://api.minimaxi.com',
  GLOBAL: 'https://www.minimax.io',
}

/** Upstream path of the Token Plan remains endpoint. */
const REMAINS_PATH = '/v1/token_plan/remains'

/** Loopback-only route the browser half reads. */
const ROUTE_PATH = '/api/minimax-quota/remains'

/** Upstream status codes that mean "this key does not belong to this region". */
const AUTH_STATUS_CODES = new Set([1004, 2049])

const DEFAULTS = {
  /** Environment-variable-shaped credential reference holding the MiniMax key. */
  apiKeyEnv: 'MINIMAX_CN_API_KEY',
  /** `CN`, `GLOBAL`, or `AUTO` to probe both and keep the one that answers. */
  region: 'CN',
  /** How often the upstream endpoint is polled. */
  pollIntervalMs: 60_000,
  /** `model_remains[].model_name` of the quota bucket to display. */
  bucket: 'general',
  /** Prefix of the status-line reading. */
  label: 'MiniMax 5h',
  /** At or below this percentage the reading turns amber. */
  warnPercent: 30,
  /** At or below this percentage the reading turns red and warns. */
  criticalPercent: 10,
  /** Per-request timeout against the upstream endpoint. */
  requestTimeoutMs: 15_000,
}

const REGION_NAMES = ['CN', 'GLOBAL']

/** A upstream rejection carrying MiniMax's own status code. */
class MiniMaxError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.name = 'MiniMaxError'
    this.statusCode = statusCode
  }
}

/**
 * Merge the row's configuration over the defaults and clamp every value into
 * a range the poller and the browser half can rely on.
 *
 * @param {unknown} raw - the row's `config` object.
 * @returns {typeof DEFAULTS} the effective configuration.
 */
function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const region = String(source.region ?? DEFAULTS.region).toUpperCase()
  return {
    apiKeyEnv: typeof source.apiKeyEnv === 'string' && source.apiKeyEnv !== ''
      ? source.apiKeyEnv
      : DEFAULTS.apiKeyEnv,
    region: REGION_NAMES.includes(region) ? region : 'AUTO',
    pollIntervalMs: clampNumber(source.pollIntervalMs, DEFAULTS.pollIntervalMs, 15_000, 3_600_000),
    bucket: typeof source.bucket === 'string' && source.bucket !== '' ? source.bucket : DEFAULTS.bucket,
    label: typeof source.label === 'string' && source.label !== '' ? source.label : DEFAULTS.label,
    warnPercent: clampNumber(source.warnPercent, DEFAULTS.warnPercent, 0, 100),
    criticalPercent: clampNumber(source.criticalPercent, DEFAULTS.criticalPercent, 0, 100),
    requestTimeoutMs: clampNumber(source.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 1_000, 120_000),
  }
}

/**
 * @param {unknown} value - the candidate number.
 * @param {number} fallback - the value used when the candidate is unusable.
 * @param {number} min - the inclusive lower bound.
 * @param {number} max - the inclusive upper bound.
 * @returns {number} the clamped number.
 */
function clampNumber(value, fallback, min, max) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, numeric))
}

/**
 * @param {unknown} value - the candidate number.
 * @returns {number | undefined} the number, or undefined when it is not one.
 */
function toFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Resolve the MiniMax API key. The configured reference wins; the provider
 * table of the `llm-pi-ai` settings namespace is the fallback, so a profile
 * that already configured a MiniMax route needs no extra configuration.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the Host context.
 * @param {typeof DEFAULTS} config - the effective configuration.
 * @returns {Promise<{ value: string, env: string } | undefined>} the key.
 */
async function resolveApiKey(ctx, config) {
  const candidates = [config.apiKeyEnv, ...detectProviderEnvNames(ctx)]
  for (const name of candidates) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
    const value = await resolveCredential(ctx, name)
    if (value) return { value, env: name }
  }
  return undefined
}

/**
 * Read the credential reference through the Host credential store, falling
 * back to the ambient process environment.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the Host context.
 * @param {string} name - the credential reference.
 * @returns {Promise<string | undefined>} the secret value.
 */
async function resolveCredential(ctx, name) {
  try {
    const credentials = ctx.get('credentials')
    if (credentials && typeof credentials.resolve === 'function') {
      const hit = await credentials.resolve(name)
      if (hit && typeof hit.value === 'string' && hit.value !== '') return hit.value
    }
  } catch {
    // A profile without a credential store simply has no stored key.
  }
  const ambient = process.env[name]
  if (typeof ambient === 'string' && ambient !== '') return ambient
  return undefined
}

/**
 * Discover the credential references of the configured MiniMax routes.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the Host context.
 * @returns {string[]} the reference names, most specific first.
 */
function detectProviderEnvNames(ctx) {
  try {
    const settings = ctx.get('settings')
    if (!settings || typeof settings.describe !== 'function') return []
    const rows = settings.describe({ redactSecrets: true })
    const namespace = rows.find((row) => row && row.ns === 'llm-pi-ai')
    const providers = namespace?.value?.providers
    if (!providers || typeof providers !== 'object') return []
    const names = []
    for (const [route, entry] of Object.entries(providers)) {
      if (!/minimax/i.test(route)) continue
      const env = entry && typeof entry === 'object' ? entry.apiKeyEnv : undefined
      if (typeof env === 'string' && env !== '') names.push(env)
    }
    return names
  } catch {
    return []
  }
}

/**
 * Ask MiniMax for the current quota windows.
 *
 * @param {string} region - the region origin to use.
 * @param {string} apiKey - the MiniMax API key.
 * @param {number} timeoutMs - the request timeout.
 * @returns {Promise<Record<string, unknown>>} the parsed response body.
 */
async function fetchRemains(region, apiKey, timeoutMs) {
  const origin = REGION_ORIGINS[region]
  if (!origin) throw new Error(`unknown MiniMax region "${region}"`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(origin + REMAINS_PATH, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
      signal: controller.signal,
    })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`HTTP ${response.status}: the response was not JSON`)
    }
    const base = body?.base_resp
    if (base && typeof base.status_code === 'number' && base.status_code !== 0) {
      throw new MiniMaxError(base.status_code, base.status_msg || `MiniMax status ${base.status_code}`)
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${base?.status_msg || text.slice(0, 200)}`)
    }
    return body
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`the request to ${origin} timed out`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Pick the quota bucket to display. The configured name wins; otherwise a
 * text-shaped bucket is preferred over buckets such as `video`.
 *
 * @param {Record<string, unknown>[]} entries - the `model_remains` entries.
 * @param {string} wanted - the configured bucket name.
 * @returns {Record<string, unknown> | undefined} the chosen entry.
 */
function pickBucket(entries, wanted) {
  if (!Array.isArray(entries) || entries.length === 0) return undefined
  const target = String(wanted ?? '').toLowerCase()
  if (target !== '') {
    const exact = entries.find((entry) => String(entry?.model_name ?? '').toLowerCase() === target)
    if (exact) return exact
  }
  const textual = entries.find((entry) =>
    /general|text|chat|llm|language|code|coding/i.test(String(entry?.model_name ?? '')),
  )
  return textual ?? entries[0]
}

/**
 * Read the remaining percentage of a bucket, tolerating the two shapes the
 * count fields are known to take.
 *
 * @param {Record<string, unknown>} entry - the `model_remains` entry.
 * @returns {{ percent: number | null, source: string | null, total: number | undefined, usage: number | undefined }} the reading.
 */
function resolvePercent(entry) {
  const total = toFiniteNumber(entry?.current_interval_total_count)
  const usage = toFiniteNumber(entry?.current_interval_usage_count)
  const explicit = toFiniteNumber(entry?.current_interval_remaining_percent)
  if (explicit !== undefined && explicit >= 0 && explicit <= 100) {
    return { percent: explicit, source: 'percent', total, usage }
  }
  if (total !== undefined && total > 0 && usage !== undefined) {
    if (usage > total) {
      const percent = Math.min(100, Math.max(0, (usage / total) * 100))
      return { percent, source: 'counts-inverted', total, usage }
    }
    const percent = Math.min(100, Math.max(0, ((total - usage) / total) * 100))
    return { percent, source: 'counts', total, usage }
  }
  return { percent: null, source: null, total, usage }
}

/**
 * Read the reset time of a bucket.
 *
 * @param {Record<string, unknown>} entry - the `model_remains` entry.
 * @returns {{ resetAt: number | null, resetsInMs: number | null }} the reset time.
 */
function resolveReset(entry) {
  const end = toFiniteNumber(entry?.end_time)
  const remains = toFiniteNumber(entry?.remains_time)
  const now = Date.now()
  let resetAt = null
  let resetsInMs = null
  if (remains !== undefined && remains >= 0) {
    resetsInMs = remains
    resetAt = now + remains
  }
  if (end !== undefined && end > 0) {
    const fromEnd = end - now
    // `remains_time` counts the interval itself; `end_time` may mark the end
    // of a wider window. Prefer the interval remainder whenever the two
    // disagree, so the countdown never over-promises.
    if (resetsInMs === undefined || Math.abs(fromEnd - resetsInMs) <= 60_000) {
      resetAt = end
      if (resetsInMs === undefined) resetsInMs = Math.max(0, fromEnd)
    }
  }
  return { resetAt, resetsInMs }
}

/**
 * Read the length of the counted window.
 *
 * @param {Record<string, unknown>} entry - the `model_remains` entry.
 * @returns {number | null} the window length in milliseconds.
 */
function resolveWindow(entry) {
  const start = toFiniteNumber(entry?.start_time)
  const end = toFiniteNumber(entry?.end_time)
  if (start !== undefined && end !== undefined && end > start) return end - start
  return null
}

/**
 * Turn an upstream response into the snapshot the browser half renders.
 *
 * @param {string} region - the region that answered.
 * @param {Record<string, unknown>} body - the upstream response body.
 * @param {typeof DEFAULTS} config - the effective configuration.
 * @returns {Record<string, unknown>} the snapshot.
 */
function buildSnapshot(region, body, config) {
  const entries = Array.isArray(body?.model_remains) ? body.model_remains : []
  const entry = pickBucket(entries, config.bucket)
  if (!entry) {
    return {
      ok: false,
      error: 'the response carried no quota bucket',
      region,
      label: config.label,
      updatedAt: Date.now(),
    }
  }
  const { percent, source, total, usage } = resolvePercent(entry)
  const { resetAt, resetsInMs } = resolveReset(entry)
  return {
    ok: true,
    region,
    label: config.label,
    bucket: typeof entry.model_name === 'string' ? entry.model_name : config.bucket,
    remainingPercent: percent,
    percentSource: source,
    totalCount: total ?? null,
    usageCount: usage ?? null,
    weeklyRemainingPercent: toFiniteNumber(entry?.current_weekly_remaining_percent) ?? null,
    resetAt,
    resetsInMs,
    windowMs: resolveWindow(entry),
    warnPercent: config.warnPercent,
    criticalPercent: config.criticalPercent,
    updatedAt: Date.now(),
  }
}

/**
 * @param {unknown} error - the thrown value.
 * @returns {string} a short, safe description.
 */
function describeError(error) {
  if (error instanceof MiniMaxError) return `MiniMax ${error.statusCode}: ${error.message}`
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} whether the peer is on the loopback interface.
 */
function isLoopbackPeer(req) {
  const address = req.socket?.remoteAddress
  if (typeof address !== 'string') return false
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/**
 * @param {string} host - the Host header value.
 * @returns {string} the lower-cased host name without its port.
 */
function hostNameOf(host) {
  const trimmed = host.trim()
  const bracket = /^\[([0-9a-fA-F:]+)\](?::\d+)?$/.exec(trimmed)
  if (bracket !== null) return (bracket[1] ?? '').toLowerCase()
  if ((trimmed.match(/:/g) ?? []).length > 1) return trimmed.toLowerCase()
  return trimmed.split(':')[0]?.toLowerCase() ?? ''
}

/**
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} whether the Host header names the loopback interface.
 */
function isLoopbackHost(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return true
  const name = hostNameOf(host)
  return name === 'localhost' || name === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
}

/**
 * @param {string | undefined} origin - the Origin header value.
 * @returns {boolean} whether the origin is a loopback origin.
 */
function isLoopbackOrigin(origin) {
  if (typeof origin !== 'string' || origin === '') return true
  try {
    const raw = new URL(origin).hostname
    const host = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
    return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  } catch {
    return false
  }
}

/**
 * Host plugin body: poll MiniMax and serve the snapshot to the browser half.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the Host context.
 * @param {Record<string, unknown>} [config] - the row's configuration.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const state = {
    /** The snapshot the browser half reads. */
    snapshot: { ok: false, error: 'the first poll has not finished yet', updatedAt: Date.now() },
    /** The region that last answered; `AUTO` pins it after the first success. */
    region: settings.region === 'AUTO' ? undefined : settings.region,
    /** Guards against a slow upstream call overlapping the next tick. */
    inFlight: false,
  }

  const poll = async () => {
    if (state.inFlight) return
    state.inFlight = true
    try {
      const credential = await resolveApiKey(ctx, settings)
      if (!credential) {
        state.snapshot = {
          ok: false,
          error: `no MiniMax API key found for "${settings.apiKeyEnv}"`,
          updatedAt: Date.now(),
        }
        return
      }
      const regions = state.region ? [state.region] : REGION_NAMES
      let failure
      for (const region of regions) {
        try {
          const body = await fetchRemains(region, credential.value, settings.requestTimeoutMs)
          state.region = region
          state.snapshot = buildSnapshot(region, body, settings)
          return
        } catch (error) {
          failure = error
          // A key that belongs to the other region fails authentication; any
          // other failure is a transport problem worth retrying on the next
          // tick rather than on the next region.
          if (!(error instanceof MiniMaxError) || !AUTH_STATUS_CODES.has(error.statusCode)) break
        }
      }
      state.snapshot = {
        ok: false,
        error: describeError(failure),
        region: state.region ?? settings.region,
        label: settings.label,
        updatedAt: Date.now(),
      }
    } catch (error) {
      state.snapshot = {
        ok: false,
        error: describeError(error),
        updatedAt: Date.now(),
      }
    } finally {
      state.inFlight = false
    }
  }

  ctx.effect(() => {
    const timer = setInterval(() => {
      void poll()
    }, settings.pollIntervalMs)
    timer.unref?.()
    void poll()
    return () => clearInterval(timer)
  }, 'minimax-quota: poll timer')

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
            return
          }
          if (!isLoopbackPeer(req) || !isLoopbackHost(req) || !isLoopbackOrigin(req.headers.origin)) {
            res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'forbidden: loopback only' }))
            return
          }
          const body = JSON.stringify(state.snapshot)
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(req.method === 'HEAD' ? undefined : body)
        },
      }),
    'minimax-quota: route',
  )
}
