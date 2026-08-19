import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { waitForReady } from '../electron/ready'
import { createServer, type Server } from 'node:http'

describe('waitForReady', () => {
  let server: Server | undefined
  let port: number

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = undefined
    }
  })

  it('resolves when the server responds 200', async () => {
    server = createServer((req, res) => { res.writeHead(200); res.end('ok') })
    port = await new Promise<number>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        resolve((server!.address() as { port: number }).port)
      })
    })
    await waitForReady({ url: `http://127.0.0.1:${String(port)}`, timeoutMs: 5000, intervalMs: 100 })
  })

  it('rejects on timeout when no server is running', async () => {
    // Use an unlikely high port that nothing is listening on.
    const start = Date.now()
    await expect(
      waitForReady({ url: 'http://127.0.0.1:59998', timeoutMs: 500, intervalMs: 100 }),
    ).rejects.toThrow(/did not respond with HTTP 200 within .* \(observed: ECONNREFUSED x/)
    expect(Date.now() - start).toBeGreaterThanOrEqual(400)
  })

  it('timeout error includes the observed status-code summary', async () => {
    // A server that always answers 404 (dsh boot window before the SPA
    // fallback is registered) must surface as `HTTP 404 x<n>` in the error.
    server = createServer((req, res) => { res.writeHead(404); res.end() })
    const port404 = await new Promise<number>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        resolve((server!.address() as { port: number }).port)
      })
    })
    const err = await waitForReady({
      url: `http://127.0.0.1:${String(port404)}`,
      timeoutMs: 400,
      intervalMs: 50,
    }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/observed: HTTP 404 x/)
  })

  it('rejects on AbortSignal cancellation', async () => {
    const controller = new AbortController()
    const promise = waitForReady({
      url: 'http://127.0.0.1:59997',
      timeoutMs: 10000,
      intervalMs: 100,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 50)
    await expect(promise).rejects.toThrow(/aborted/)
  })

  it('uses default timeout and interval when omitted', async () => {
    // Just verify the function signature accepts omitted options.
    // We don't wait the full 30s default; instead test with a fast server.
    server = createServer((req, res) => { res.writeHead(200); res.end() })
    port = await new Promise<number>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        resolve((server!.address() as { port: number }).port)
      })
    })
    await waitForReady({ url: `http://127.0.0.1:${String(port)}` })
  })

  it('handles non-200 responses by continuing to poll', async () => {
    let requestCount = 0
    server = createServer((req, res) => {
      requestCount++
      if (requestCount < 3) { res.writeHead(503); res.end() }
      else { res.writeHead(200); res.end() }
    })
    port = await new Promise<number>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        resolve((server!.address() as { port: number }).port)
      })
    })
    await waitForReady({ url: `http://127.0.0.1:${String(port)}`, timeoutMs: 5000, intervalMs: 50 })
    expect(requestCount).toBeGreaterThanOrEqual(3)
  })
})
