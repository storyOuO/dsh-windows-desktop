/**
 * dsh child-process manager: resolves the dsh bin, spawns it with the right
 * Node binary, collects stdout/stderr, parses the URL line, and owns the
 * process lifecycle (graceful SIGTERM → forceful kill).
 *
 * In a packaged Electron app, `process.execPath` is the Electron binary.
 * Setting `ELECTRON_RUN_AS_NODE=1` in the child env makes it behave as a
 * plain Node.js runtime — without this, `spawn` opens a second blank
 * Electron window instead of running dsh.
 * @module electron/dsh-process
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync } from 'node:fs'

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
  /** Timeout in ms for waitForUrl; defaults to 30 s. */
  urlTimeoutMs?: number
  /**
   * Append every stdout/stderr line to this file. The packaged Windows app
   * has no console, so without a log file the dsh backend's output (boot
   * progress, Cordis fiber failures) is invisible when diagnosing startup
   * problems.
   */
  logFile?: string
}

/** Parsed URL line emitted by dsh web. */
export interface DshUrlInfo {
  /** Full loopback URL, e.g. `http://127.0.0.1:3080`. */
  url: string
  port: number
}

/** Match `dsh web: http://127.0.0.1:3080` (optionally followed by LAN info). */
const URL_LINE_REGEX = /dsh web:\s+(http:\/\/\S+)/

/** Default timeout for waiting on the URL line: 30 s. */
const DEFAULT_URL_TIMEOUT_MS = 30_000

/** Collected stderr lines for error reporting. */
const MAX_STDERR_LINES = 50

/**
 * Manages one dsh web child process. The caller starts it with {@link
 * DshProcess.start}, awaits {@link DshProcess.waitForUrl} for the URL line,
 * and stops it with {@link DshProcess.stop}.
 */
export class DshProcess {
  private child: ChildProcessWithoutNullStreams | undefined
  /** Accumulated stdout text for URL-line parsing. */
  private stdoutText = ''
  /** Accumulated stderr lines for error diagnostics. */
  private stderrLines: string[] = []
  /** All stdout/stderr lines in order, for the error-dialog tail. */
  private outputLines: string[] = []
  private urlResolve: ((info: DshUrlInfo) => void) | undefined
  private urlReject: ((err: Error) => void) | undefined
  private urlTimer: ReturnType<typeof setTimeout> | undefined
  private readonly logger: (line: string) => void
  private readonly urlTimeoutMs: number

  constructor(private readonly options: DshProcessOptions) {
    this.logger = options.logger ?? (() => {})
    this.urlTimeoutMs = options.urlTimeoutMs ?? DEFAULT_URL_TIMEOUT_MS
  }

  /** Emit one output line to the logger and, when configured, the log file. */
  private emitLine(line: string): void {
    this.logger(line)
    if (this.options.logFile !== undefined) {
      try { appendFileSync(this.options.logFile, `${line}\n`) } catch { /* disk full/permissions — logging must never crash the app */ }
    }
  }

  /**
   * The last lines of the child's combined output, for error dialogs.
   * @param maxLines - maximum number of trailing lines to include.
   * @returns the recent output tail, or a placeholder when silent.
   */
  getRecentOutput(maxLines = 30): string {
    const lines = this.outputLines
    if (lines.length === 0) return '(no backend output)'
    return lines.slice(-maxLines).join('\n')
  }

  /**
   * Spawn the dsh web child process. Sets `ELECTRON_RUN_AS_NODE=1` so the
   * Electron binary acts as a plain Node.js runtime.
   * @throws if the bin path cannot be resolved.
   */
  start(): void {
    const nodePath = this.options.nodePath ?? process.execPath
    const dshBin = this.options.dshBinPath ?? this.resolveDshBin()
    const args = [dshBin, 'web', '--port', String(this.options.port)]
    // ELECTRON_RUN_AS_NODE=1 is the critical fix: without it, spawning the
    // Electron binary launches a new GUI window instead of a Node process.
    // Spread AFTER caller env so it always wins — a caller must not be able
    // to accidentally disable Node mode and get a blank Electron window.
    const env = {
      ...process.env,
      ...this.options.env,
      ELECTRON_RUN_AS_NODE: '1',
    }

    this.child = spawn(nodePath, args, {
      env,
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    this.child.stderr.on('data', (chunk: string) => this.onStderr(chunk))
    this.child.on('error', (err) => this.emitLine(`dsh: child error: ${err.message}`))
    this.child.on('exit', (code) => {
      this.emitLine(`dsh: child exited with code ${String(code)}`)
      this.child = undefined
      if (this.urlTimer !== undefined) { clearTimeout(this.urlTimer); this.urlTimer = undefined }
      if (this.urlResolve !== undefined) {
        const r = this.urlReject ?? ((e: Error) => { throw e })
        this.urlResolve = undefined
        this.urlReject = undefined
        r(new Error(`dsh-process: child exited before URL line (code ${String(code)})\n${this.getStderr()}`))
      }
    })
  }

  /**
   * Wait for the `dsh web: <url>` line on stdout, with a timeout.
   * @param signal - optional AbortSignal to cancel the wait.
   * @returns the parsed URL and port.
   * @throws on timeout, abort, or if the child exits before emitting a URL.
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
      this.urlReject = reject

      // Timeout: if no URL line arrives within the configured window, reject.
      this.urlTimer = setTimeout(() => {
        if (this.urlResolve !== undefined) {
          this.urlResolve = undefined
          this.urlReject = undefined
          reject(new Error(`dsh-process: no URL line within ${String(this.urlTimeoutMs)} ms\n${this.getStderr()}`))
        }
      }, this.urlTimeoutMs)

      const onAbort = (): void => {
        if (this.urlTimer !== undefined) { clearTimeout(this.urlTimer); this.urlTimer = undefined }
        this.urlResolve = undefined
        this.urlReject = undefined
        reject(new Error('dsh-process: aborted while waiting for URL line'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Gracefully stop the child: send SIGTERM, wait up to 5 s, then SIGKILL.
   */
  async stop(): Promise<void> {
    if (this.urlTimer !== undefined) { clearTimeout(this.urlTimer); this.urlTimer = undefined }
    const child = this.child
    if (child === undefined) return
    this.child = undefined
    this.urlResolve = undefined
    this.urlReject = undefined

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

  /** Collect stderr lines for error diagnostics. */
  private getStderr(): string {
    return this.stderrLines.length > 0
      ? `stderr:\n  ${this.stderrLines.join('\n  ')}`
      : '(no stderr output)'
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
      if (line.trim() !== '') {
        this.emitLine(line)
        this.outputLines.push(line)
        if (this.outputLines.length > 200) this.outputLines.shift()
      }
    }
    // Check for URL line in the full accumulated stdout.
    const info = this.parseUrlLine(this.stdoutText)
    if (info !== undefined && this.urlResolve !== undefined) {
      if (this.urlTimer !== undefined) { clearTimeout(this.urlTimer); this.urlTimer = undefined }
      const r = this.urlResolve
      this.urlResolve = undefined
      this.urlReject = undefined
      r(info)
    }
  }

  /** Log stderr lines and accumulate for error reporting. */
  private onStderr(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (line.trim() !== '') {
        this.emitLine(line)
        this.outputLines.push(line)
        if (this.outputLines.length > 200) this.outputLines.shift()
        this.stderrLines.push(line)
        if (this.stderrLines.length > MAX_STDERR_LINES) this.stderrLines.shift()
      }
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
