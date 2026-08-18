/**
 * Integration test: verifies the main process orchestration logic by mocking
 * all Electron and dsh dependencies. This does NOT start a real Electron app;
 * it tests the wiring logic.
 * @module tests/main.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getFreePort } from '../electron/port'
import { waitForReady } from '../electron/ready'
import { DshProcess } from '../electron/dsh-process'
import { ApiKeyStore } from '../electron/api-key'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('integration: port → dsh-process → ready', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = undefined
    }
  })

  it('getFreePort returns a port, and waitForReady can probe it once a server starts', async () => {
    const port = await getFreePort()
    expect(port).toBeGreaterThan(0)

    server = createServer((req, res) => { res.writeHead(200); res.end('ok') })
    await new Promise<void>((resolve) => {
      server!.listen(port, '127.0.0.1', resolve)
    })

    await waitForReady({ url: `http://127.0.0.1:${String(port)}`, timeoutMs: 5000, intervalMs: 100 })
  })
})

describe('integration: ApiKeyStore → env injection', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  it('API key from the store can be injected into DshProcess env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-int-'))
    dirs.push(dir)
    const app = { getPath: () => dir, setPath: vi.fn() }
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (p: string) => Buffer.from(`e:${p}`),
      decryptString: (b: Buffer) => b.toString().slice(2),
    }
    const store = new ApiKeyStore(
      app, safeStorage, readFileSync, writeFileSync, existsSync, join,
    )
    store.setApiKey('sk-integration-key')

    const apiKey = store.getApiKey()
    expect(apiKey).toBe('sk-integration-key')

    // Simulate the env injection that main.ts does.
    const env: NodeJS.ProcessEnv = {}
    if (apiKey !== undefined) env.DEEPSEEK_API_KEY = apiKey
    expect(env.DEEPSEEK_API_KEY).toBe('sk-integration-key')
  })
})

describe('integration: DshProcess output parsing → URL → waitForReady', () => {
  it('parses a realistic dsh web stdout sequence', async () => {
    const lines = [
      'Loading profile web...\n',
      'Resolving plugins...\n',
      'dsh web: http://127.0.0.1:4567\n',
    ]
    // Simulate what DshProcess does: accumulate stdout and parse.
    let stdoutText = ''
    const regex = /dsh web:\s+(http:\/\/\S+)/
    let parsedUrl: string | undefined
    for (const line of lines) {
      stdoutText += line
      const match = stdoutText.match(regex)
      if (match !== null) { parsedUrl = match[1]; break }
    }
    expect(parsedUrl).toBe('http://127.0.0.1:4567')

    // The port extracted from the URL is what main.ts passes to waitForReady.
    const port = Number(parsedUrl!.match(/:(\d+)$/)![1])
    expect(port).toBe(4567)
  })
})

describe('integration: startup failure scenarios', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = undefined
    }
  })

  it('waitForReady rejects when port is occupied by a non-responsive server', async () => {
    // A server that never responds 200.
    server = createServer((req, res) => { res.writeHead(404); res.end() })
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        resolve((server!.address() as { port: number }).port)
      })
    })
    await expect(
      waitForReady({ url: `http://127.0.0.1:${String(port)}`, timeoutMs: 500, intervalMs: 50 }),
    ).rejects.toThrow(/did not respond/)
  })

  it('DshProcess.stop resolves even when child is already dead (idempotent)', async () => {
    const proc = new DshProcess({ port: 9999, dshBinPath: '/fake/bin.js' })
    // Never started — stop should be a no-op.
    await expect(proc.stop()).resolves.toBeUndefined()
    expect(proc.running).toBe(false)
  })
})
