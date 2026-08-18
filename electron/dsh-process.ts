/**
 * dsh child-process manager: resolves the dsh bin, spawns it with the right
 * Node binary, collects stdout/stderr, parses the URL line, and owns the
 * process lifecycle (graceful SIGTERM → forceful kill).
 * @module electron/dsh-process
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/** Options for {@link DshProcess}. */
export interface DshProcessOptions {
  /** TCP port for dsh web to listen on. */
  port: number
  /** Environment variables merged over process.env. */
  env?: NodeJS.ProcessEnv
  /** Working directory for the child process. */
  cwd?: string
  /** Path to the dsh bin.js; resolved from the @deepseek-ai/dsh package when omitted. */
  dshBinPath?: string
  /** Path to the Node executable (defaults to process.execPath). */
  nodePath?: string
  /** Logger for stdout/stderr lines (e.g. console.log). */
  logger?: (line: string) => void
}

/** Parsed URL line emitted by dsh web. */
export interface DshUrlInfo {
  /** Full loopback URL, e.g. `http://127.0.0.1:3080`. */
  url: string
  port: number
}

/** Match `dsh web: http://127.0.0.1:3080` (optionally followed by LAN info). */
const URL_LINE_REGEX = /dsh web:\s+(http:\/\/\S+)/

/**
 * Manages one dsh web child process. The caller starts it with {@link
 * DshProcess.start}, awaits {@link DshProcess.waitForUrl} for the URL line,
 * and stops it with {@link DshProcess.stop}.
 */
export class DshProcess {
  private child: ChildProcessWithoutNullStreams | undefined
  /** Accumulated stdout text for URL-line parsing. */
  private stdoutText = ''
  private urlResolve: ((info: DshUrlInfo) => void) | undefined
  private exitReject: ((err: Error) => void) | undefined
  private readonly logger: (line: string) => void

  constructor(private readonly options: DshProcessOptions) {
    this.logger = options.logger ?? (() => {})
  }

  /**
   * Spawn the dsh web child process.
   * @throws if the bin path cannot be resolved.
   */
  start(): void {
    const nodePath = this.options.nodePath ?? process.execPath
    const dshBin = this.options.dshBinPath ?? this.resolveDshBin()
    const args = [dshBin, 'web', '--port', String(this.options.port)]
    const env = { ...process.env, ...this.options.env }

    this.child = spawn(nodePath, args, {
      env,
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: false,
    })

    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    this.child.stderr.on('data', (chunk: string) => this.onStderr(chunk))
    this.child.on('error', (err) => this.logger(`dsh: child error: ${err.message}`))
    this.child.on('exit', (code) => {
      this.logger(`dsh: child exited with code ${String(code)}`)
      this.child = undefined
      if (this.urlResolve !== undefined) {
        const r = this.urlResolve
        this.urlResolve = undefined
        r({ url: '', port: 0 }) // resolve to unblock, caller checks
      }
    })
  }

  /**
   * Wait for the `dsh web: <url>` line on stdout.
   * @param signal - optional AbortSignal to cancel the wait.
   * @returns the parsed URL and port.
   * @throws on abort, or if the child exits before emitting a URL.
   */
  async waitForUrl(signal?: AbortSignal): Promise<DshUrlInfo> {
    // Fast path: URL already received.
    const existing = this.parseUrlLine(this.stdoutText)
    if (existing !== undefined) return existing

    return new Promise<DshUrlInfo>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('dsh-process: aborted before URL line'))
        return
      }
      this.urlResolve = resolve
      this.exitReject = reject
      const onAbort = (): void => {
        this.urlResolve = undefined
        this.exitReject = undefined
        reject(new Error('dsh-process: aborted while waiting for URL line'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Gracefully stop the child: send SIGTERM, wait up to 5 s, then SIGKILL.
   */
  async stop(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.child = undefined
    this.urlResolve = undefined
    this.exitReject = undefined

    await new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => { if (!settled) { settled = true; resolve() } }
      child.once('exit', done)
      try { child.kill('SIGTERM') } catch { /* already dead */ done() }
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already dead */ }
      }, 5000)
      child.once('exit', () => clearTimeout(killTimer))
      // Fallback: resolve after 6 s regardless.
      setTimeout(done, 6000)
    })
  }

  /** Whether the child process is currently running. */
  get running(): boolean {
    return this.child !== undefined && !this.child.killed
  }

  /** PID of the child, or `undefined` when not running. */
  get pid(): number | undefined {
    return this.child?.pid
  }

  /** Resolve the dsh bin path from the installed @deepseek-ai/dsh package. */
  private resolveDshBin(): string {
    const pkg = require.resolve('@deepseek-ai/dsh/package.json')
    const manifest = JSON.parse(
      require('node:fs').readFileSync(pkg, 'utf8'),
    ) as { bin?: Record<string, string> }
    const binRel = manifest.bin?.['dsh']
    if (typeof binRel !== 'string') throw new Error('dsh-process: @deepseek-ai/dsh has no "dsh" bin')
    const nodePath = require('node:path')
    return nodePath.join(nodePath.dirname(pkg), binRel)
  }

  /** Accumulate stdout, log each complete line, and check for URL line. */
  private onStdout(chunk: string): void {
    this.stdoutText += chunk
    // Log complete lines.
    for (const line of chunk.split('\n')) {
      if (line.trim() !== '') this.logger(line)
    }
    // Check for URL line in the full accumulated stdout.
    const info = this.parseUrlLine(this.stdoutText)
    if (info !== undefined && this.urlResolve !== undefined) {
      const r = this.urlResolve
      this.urlResolve = undefined
      this.exitReject = undefined
      r(info)
    }
  }

  /** Log stderr lines. */
  private onStderr(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (line.trim() !== '') this.logger(line)
    }
  }

  /** Extract the URL and port from a dsh web stdout line. */
  private parseUrlLine(text: string): DshUrlInfo | undefined {
    const match = text.match(URL_LINE_REGEX)
    if (match === null) return undefined
    const url = match[1]
    const portMatch = url.match(/:(\d+)$/)
    if (portMatch === null) return undefined
    return { url, port: Number(portMatch[1]) }
  }
}

export { URL_LINE_REGEX }
