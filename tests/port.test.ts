import { describe, it, expect } from 'vitest'
import { getFreePort } from '../electron/port'

describe('getFreePort', () => {
  it('returns a number in the ephemeral range', async () => {
    const port = await getFreePort()
    expect(typeof port).toBe('number')
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65535)
  })

  it('returns a port that is immediately bindable', async () => {
    const port = await getFreePort()
    const { createServer } = await import('node:net')
    await new Promise<void>((resolve, reject) => {
      const server = createServer()
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve())
      })
      server.on('error', reject)
    })
  })

  it('returns different ports on consecutive calls (high probability)', async () => {
    const ports = await Promise.all([getFreePort(), getFreePort(), getFreePort()])
    const unique = new Set(ports)
    expect(unique.size).toBeGreaterThanOrEqual(2)
  })
})
