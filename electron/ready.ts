/**
 * HTTP readiness probe: poll a URL until it responds 200 or the timeout
 * expires. Used to wait for the dsh web server to finish booting before
 * loading the BrowserWindow.
 *
 * During Cordis plugin initialization, the web server returns 404 for
 * unmatched routes (the SPA fallback seat has not been claimed yet). This
 * is expected — the probe keeps polling. On timeout, the error message
 * includes the distribution of observed responses (status codes and
 * connection errors), which distinguishes "still booting" (404s) from a
 * permanent backend fault (400s, 403s, ECONNREFUSED, or no response).
 * @module electron/ready
 */

import { request } from 'node:http'

/** Options for {@link waitForReady}. */
export interface WaitForReadyOptions {
  /** URL to probe (e.g. `http://127.0.0.1:3080`). */
  url: string
  /** Total timeout in milliseconds before rejecting. */
  timeoutMs?: number
  /** Polling interval in milliseconds. */
  intervalMs?: number
  /** AbortSignal to cancel the wait externally. */
  signal?: AbortSignal
}

/** Default total timeout: 30 s. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Default polling interval: 200 ms. */
const DEFAULT_INTERVAL_MS = 200

/** Outcome of one probe: either an HTTP status code or a connection-level failure. */
type ProbeResult = { kind: 'status', code: number } | { kind: 'error', message: string }

/**
 * Probe a URL with a short GET.
 * @param url - the URL to probe.
 * @returns the HTTP status code, or the connection error message.
 */
function probe(url: string): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const req = request(url, { method: 'GET', timeout: 2000 }, (res) => {
      res.resume()
      resolve({ kind: 'status', code: res.statusCode ?? 0 })
    })
    req.on('error', (err: NodeJS.ErrnoException) => {
      resolve({ kind: 'error', message: err.code ?? err.message })
    })
    req.on('timeout', () => { req.destroy(); resolve({ kind: 'error', message: 'ETIMEDOUT' }) })
    req.end()
  })
}

/**
 * Render a probe-result tally for diagnostics, e.g.
 * `404 x12, ECONNREFUSED x3`.
 * @param counts - observed probe results to their occurrence counts.
 * @returns the compact summary, or `no responses` when nothing was observed.
 */
export function summarizeProbeResults(counts: Map<string, number>): string {
  if (counts.size === 0) return 'no responses'
  return [...counts.entries()].map(([key, n]) => `${key} x${String(n)}`).join(', ')
}

/**
 * Poll a URL until it responds HTTP 200, or reject on timeout / cancellation.
 * @param options - URL, timeouts, and optional cancel signal.
 * @returns resolves when the server is ready.
 * @throws on timeout (with the observed response summary), external
 * cancellation, or a probe that never succeeds.
 */
export async function waitForReady(options: WaitForReadyOptions): Promise<void> {
  const { url, signal } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const deadline = Date.now() + timeoutMs
  const observed = new Map<string, number>()

  const record = (result: ProbeResult): void => {
    const key = result.kind === 'status' ? `HTTP ${String(result.code)}` : result.message
    observed.set(key, (observed.get(key) ?? 0) + 1)
  }

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error(`ready: aborted while waiting for ${url}`)
    const result = await probe(url)
    record(result)
    if (result.kind === 'status' && result.code === 200) return
    await sleep(intervalMs)
  }
  throw new Error(
    `ready: ${url} did not respond with HTTP 200 within ${String(timeoutMs)} ms `
    + `(observed: ${summarizeProbeResults(observed)})`,
  )
}

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}
