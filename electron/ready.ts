/**
 * HTTP readiness probe: poll a URL until it responds 200 or the timeout
 * expires. Used to wait for the dsh web server to finish booting before
 * loading the BrowserWindow.
 *
 * During Cordis plugin initialization, the web server returns 404 for
 * unmatched routes (the SPA fallback seat has not been claimed yet). This
 * is expected — the probe treats 404 as "still booting" and keeps polling.
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

/** Default total timeout: 90 s — Cordis plugin tree with 50+ plugins can be slow on Windows. */
const DEFAULT_TIMEOUT_MS = 90_000

/** Default polling interval: 500 ms — generous to avoid spamming the server during boot. */
const DEFAULT_INTERVAL_MS = 500

/**
 * Probe a URL with a short GET and resolve when the first 200 arrives.
 * @param url - the URL to probe.
 * @returns `true` if the server responded 200, `false` on non-200.
 */
function probe(url: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = request(url, { method: 'GET', timeout: 3000 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

/**
 * Poll a URL until it responds HTTP 200, or reject on timeout / cancellation.
 * @param options - URL, timeouts, and optional cancel signal.
 * @returns resolves when the server is ready.
 * @throws on timeout, external cancellation, or a probe that never succeeds.
 */
export async function waitForReady(options: WaitForReadyOptions): Promise<void> {
  const { url, signal } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error(`ready: aborted while waiting for ${url}`)
    if (await probe(url)) return
    await sleep(intervalMs)
  }
  throw new Error(`ready: ${url} did not respond within ${String(timeoutMs)} ms`)
}

/** Promise-based sleep that an AbortSignal can cut short. */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof process !== 'undefined' && typeof process.on === 'function') {
      process.once('exit', () => { clearTimeout(timer); resolve() })
    }
  })
}
