import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DshProcess, URL_LINE_REGEX } from '../electron/dsh-process'
import type { DshUrlInfo } from '../electron/dsh-process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

/** Use vi.hoisted so the mock variable is available when vi.mock factory runs. */
const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }))

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}))

/** Create a fake ChildProcess mock with EventEmitter-like behavior. */
function createFakeChild(): ChildProcessWithoutNullStreams & {
  emitData: (stream: 'stdout' | 'stderr', data: string) => void
  emitExit: (code: number) => void
  emitError: (err: Error) => void
} {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
  const child = {
    pid: 12345,
    killed: false,
    stdout: {
      setEncoding: vi.fn(),
      on: vi.fn((ev: string, cb: (...args: unknown[]) => void) => { (handlers[`stdout`] ??= []).push(cb) }),
    },
    stderr: {
      setEncoding: vi.fn(),
      on: vi.fn((ev: string, cb: (...args: unknown[]) => void) => { (handlers[`stderr`] ??= []).push(cb) }),
    },
    on: vi.fn((ev: string, cb: (...args: unknown[]) => void) => { (handlers[ev] ??= []).push(cb) }),
    once: vi.fn((ev: string, cb: (...args: unknown[]) => void) => { (handlers[ev] ??= []).push(cb) }),
    kill: vi.fn((signal?: string) => {
      child.killed = true
      setTimeout(() => {
        (handlers['exit'] ?? []).forEach(cb => cb(signal === 'SIGKILL' ? null : 0))
      }, 10)
    }),
  } as unknown as ChildProcessWithoutNullStreams & {
    emitData: (stream: 'stdout' | 'stderr', data: string) => void
    emitExit: (code: number) => void
    emitError: (err: Error) => void
  }

  child.emitData = (stream: 'stdout' | 'stderr', data: string) => {
    (handlers[stream] ?? []).forEach(cb => cb(data))
  }
  child.emitExit = (code: number) => {
    (handlers['exit'] ?? []).forEach(cb => cb(code))
  }
  child.emitError = (err: Error) => {
    (handlers['error'] ?? []).forEach(cb => cb(err))
  }

  return child
}

describe('URL_LINE_REGEX', () => {
  it('matches the basic dsh web URL line', () => {
    const text = '$ dsh web: http://127.0.0.1:3080\n'
    const match = text.match(URL_LINE_REGEX)
    expect(match).not.toBeNull()
    expect(match![1]).toBe('http://127.0.0.1:3080')
  })

  it('matches a URL line with LAN suffix', () => {
    const text = 'dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.5:3080)'
    const match = text.match(URL_LINE_REGEX)
    expect(match).not.toBeNull()
    expect(match![1]).toBe('http://127.0.0.1:3080')
  })

  it('does not match other output lines', () => {
    expect('some other line'.match(URL_LINE_REGEX)).toBeNull()
    expect(''.match(URL_LINE_REGEX)).toBeNull()
  })

  it('matches with non-standard port', () => {
    const text = 'dsh web: http://127.0.0.1:49999'
    const match = text.match(URL_LINE_REGEX)
    expect(match).not.toBeNull()
    expect(match![1]).toBe('http://127.0.0.1:49999')
  })
})

describe('DshProcess', () => {
  let fakeChild: ReturnType<typeof createFakeChild>

  beforeEach(() => {
    fakeChild = createFakeChild()
    mockSpawn.mockReturnValue(fakeChild)
  })

  afterEach(() => {
    mockSpawn.mockReset()
  })

  it('starts the child with correct arguments', () => {
    const proc = new DshProcess({ port: 8080, dshBinPath: '/fake/dsh/bin.js' })
    proc.start()
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      ['/fake/dsh/bin.js', 'web', '--port', '8080'],
      expect.objectContaining({
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    )
  })

  it('sets ELECTRON_RUN_AS_NODE=1 in the child env', () => {
    const proc = new DshProcess({ port: 3080, dshBinPath: '/fake/bin.js' })
    proc.start()
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
      }),
    )
  })

  it('passes custom env vars through to the child', () => {
    const proc = new DshProcess({
      port: 8080,
      dshBinPath: '/fake/bin.js',
      env: { DEEPSEEK_API_KEY: 'sk-test' },
    })
    proc.start()
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        env: expect.objectContaining({ DEEPSEEK_API_KEY: 'sk-test' }),
      }),
    )
  })

  it('uses custom nodePath when provided', () => {
    const proc = new DshProcess({
      port: 8080,
      dshBinPath: '/fake/bin.js',
      nodePath: '/custom/node',
    })
    proc.start()
    expect(mockSpawn).toHaveBeenCalledWith('/custom/node', expect.anything(), expect.anything())
  })

  it('parses the URL from stdout and resolves waitForUrl', async () => {
    const proc = new DshProcess({ port: 3080, dshBinPath: '/fake/bin.js' })
    proc.start()
    const urlPromise = proc.waitForUrl()
    fakeChild.emitData('stdout', 'dsh web: http://127.0.0.1:3080\n')
    const info = await urlPromise
    expect(info.url).toBe('http://127.0.0.1:3080')
    expect(info.port).toBe(3080)
  })

  it('resolves waitForUrl immediately when URL is already in buffer', async () => {
    const proc = new DshProcess({ port: 3080, dshBinPath: '/fake/bin.js' })
    proc.start()
    fakeChild.emitData('stdout', 'dsh web: http://127.0.0.1:3080\n')
    const info = await proc.waitForUrl()
    expect(info.url).toBe('http://127.0.0.1:3080')
  })

  it('logs stdout lines via the logger', () => {
    const logger = vi.fn()
    const proc = new DshProcess({ port: 3080, dshBinPath: '/fake/bin.js', logger })
    proc.start()
    fakeChild.emitData('stdout', 'line 1\nline 2\n')
    expect(logger).toHaveBeenCalledWith('line 1')
    expect(logger).toHaveBeenCalledWith('line 2')
  })

  it('logs stderr lines via the logger', () => {
    const logger = vi.fn()
    const proc = new DshProcess({ port: 3080, dshBinPath: '/fake/bin.js', logger })
    proc.start()
    fakeChild.emitData('stderr', 'warning\n')
    expect(logger).toHaveBeenCalledWith('warning')
  })

  it('logs child error events', () => {
    const logger = vi.fn()
    const proc = new DshProcess({ port: 3080, dshBinPath: '/fake/bin.js', logger })
    proc.start()
    fakeChild.emitError(new Error('spawn failed'))
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('spawn failed'))
  })

  it('stops the child with SIGTERM on stop()', async () => {
    const proc = new DshProcess({ port: 3080, dshBinPath: '/fake/bin.js' })
    proc.start()
    await proc.stop()
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('reports running=false before start and after stop', async () => {
    const proc = new DshProcess({ port: 3080, dshBinPath: '/fake/bin.js' })
    expect(proc.running).toBe(false)
    proc.start()
    expect(proc.running).toBe(true)
    await proc.stop()
    expect(proc.running).toBe(false)
  })

  it('exposes the child PID after start', () => {
    const proc = new DshProcess({ port: 3080, dshBinPath: '/fake/bin.js' })
    expect(proc.pid).toBeUndefined()
    proc.start()
    expect(proc.pid).toBe(12345)
  })

  it('stop() is a no-op when not running', async () => {
    const proc = new DshProcess({ port: 3080, dshBinPath: '/fake/bin.js' })
    await expect(proc.stop()).resolves.toBeUndefined()
  })

  it('rejects waitForUrl on AbortSignal', async () => {
    const proc = new DshProcess({ port: 3080, dshBinPath: '/fake/bin.js' })
    proc.start()
    const controller = new AbortController()
    const promise = proc.waitForUrl(controller.signal)
    controller.abort()
    await expect(promise).rejects.toThrow(/aborted/)
  })

  it('handles URL arriving in multiple chunks', async () => {
    const proc = new DshProcess({ port: 3080, dshBinPath: '/fake/bin.js' })
    proc.start()
    const urlPromise = proc.waitForUrl()
    fakeChild.emitData('stdout', 'dsh web: http://')
    fakeChild.emitData('stdout', '127.0.0.1:3080\n')
    const info = await urlPromise
    expect(info.port).toBe(3080)
  })

  it('rejects waitForUrl on timeout when no URL line arrives', async () => {
    const proc = new DshProcess({ port: 3080, dshBinPath: '/fake/bin.js', urlTimeoutMs: 100 })
    proc.start()
    await expect(proc.waitForUrl()).rejects.toThrow(/no URL line within/)
  })

  it('rejects waitForUrl when child exits before URL line', async () => {
    const proc = new DshProcess({ port: 3080, dshBinPath: '/fake/bin.js' })
    proc.start()
    const urlPromise = proc.waitForUrl()
    fakeChild.emitExit(1)
    await expect(urlPromise).rejects.toThrow(/child exited before URL line/)
  })

  it('custom env vars do not override ELECTRON_RUN_AS_NODE', () => {
    const proc = new DshProcess({
      port: 3080,
      dshBinPath: '/fake/bin.js',
      env: { ELECTRON_RUN_AS_NODE: '0', CUSTOM: 'val' },
    })
    proc.start()
    const callEnv = mockSpawn.mock.calls[0][2].env
    // ELECTRON_RUN_AS_NODE must always be '1', even if caller tries to override.
    expect(callEnv.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(callEnv.CUSTOM).toBe('val')
  })
})
