/**
 * Electron main process entry: opens the shell window immediately (loading
 * page), then asynchronously boots the dsh web backend. Success swaps the
 * page for the dsh web UI; failure renders the reason inside the window
 * with a retry button. Also owns the system tray and the API-key IPC bridge.
 * This is the only module that imports 'electron' directly; all others take
 * injected dependencies for testability.
 * @module electron/main
 */

import { app, BrowserWindow, ipcMain, shell, nativeImage, Tray, Menu, safeStorage, dialog } from 'electron'
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { getFreePort } from './port'
import { waitForReady } from './ready'
import { DshProcess } from './dsh-process'
import { ApiKeyStore } from './api-key'
import { TrayManager } from './tray'
import { shellPageUrl, type BootstrapStatus } from './pages'
import { IpcChannel, type IpcResponse } from './ipc-types'

/** Default window dimensions. */
const WINDOW_WIDTH = 1280
const WINDOW_HEIGHT = 800

/** Minimum window dimensions. */
const MIN_WIDTH = 800
const MIN_HEIGHT = 600

/** Timeout for the entire bootstrap (dsh start + URL + HTTP ready). */
const BOOTSTRAP_TIMEOUT_MS = 45_000

/** Timeout for the HTTP-ready probe after the URL line is seen. The backend
 * binds its port before printing the URL; 15 s covers plugin-tree init. */
const HTTP_READY_TIMEOUT_MS = 15_000

let dshProcess: DshProcess | undefined
let trayManager: TrayManager | undefined
let apiKeyStore: ApiKeyStore | undefined
/** The single shell window; created on launch and reused across retries. */
let shellWindow: BrowserWindow | undefined
/** Path of the main-process log file; set once userData is available. */
let mainLogPath: string | undefined

/** Append one line to the main-process log (best-effort; never throws). */
function logMain(line: string): void {
  if (mainLogPath === undefined) return
  try { appendFileSync(mainLogPath, `${line}\n`) } catch { /* disk full/permissions — logging must never crash the app */ }
}

/**
 * Initialize the main-process log. The packaged Windows app has no console,
 * so main-process errors and the bootstrap timeline otherwise vanish.
 */
function initMainLog(): void {
  mainLogPath = join(app.getPath('userData'), 'main.log')
  try { writeFileSync(mainLogPath, `--- launch ${new Date().toISOString()} ---\n`) } catch { /* non-fatal */ }
  // Mirror console.error into the log from now on.
  const originalError = console.error
  console.error = (...args: unknown[]): void => {
    originalError(...args)
    logMain(`[error] ${args.map(a => a instanceof Error ? `${a.name}: ${a.message}\n${a.stack ?? ''}` : String(a)).join(' ')}`)
  }
}

/**
 * Create the shell window showing the bootstrap loading page. Shown
 * immediately (no ready-to-show gating) so double-click feedback is
 * instant while the backend boots in the background.
 */
function createShellWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: true,
    icon: getIconPath(),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.webContents.on('did-fail-load', (_event, code, description, failedUrl) => {
    logMain(`window: did-fail-load code=${String(code)} desc=${description} url=${failedUrl}`)
  })
  void win.loadURL(shellPageUrl()).catch((err: unknown) => {
    logMain(`window: loadURL rejected: ${err instanceof Error ? err.message : String(err)}`)
  })
  return win
}

/** Push a bootstrap status update to the shell page (no-op without a page). */
function sendBootstrapStatus(status: BootstrapStatus): void {
  if (shellWindow !== undefined && !shellWindow.isDestroyed()) {
    shellWindow.webContents.send(IpcChannel.BootstrapStatus, status)
  }
}

/** Resolve the app icon path (bundled or dev). */
function getIconPath(): string | undefined {
  const devIcon = join(__dirname, '..', 'build', 'icon.ico')
  if (existsSync(devIcon)) return devIcon
  return undefined
}

/** Create a 16×16 transparent icon for the tray. */
function createTrayIcon(): string {
  // In production, use the bundled icon. In dev, use a placeholder path.
  const iconPath = join(__dirname, '..', 'build', 'tray-icon.png')
  return existsSync(iconPath) ? iconPath : join(__dirname, '..', 'build', 'icon.ico')
}

/** Wire the API-key and bootstrap IPC handlers. */
function setupIpc(): void {
  if (apiKeyStore === undefined) throw new Error('main: apiKeyStore not initialized')

  ipcMain.handle(IpcChannel.GetApiKey, async (): Promise<IpcResponse<string | undefined>> => {
    try {
      return { ok: true, data: apiKeyStore!.getApiKey() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IpcChannel.SetApiKey, async (_event, key: string): Promise<IpcResponse<void>> => {
    try {
      apiKeyStore!.setApiKey(key)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IpcChannel.DeleteApiKey, async (): Promise<IpcResponse<void>> => {
    try {
      apiKeyStore!.deleteApiKey()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IpcChannel.OpenExternal, async (_event, url: string): Promise<IpcResponse<void>> => {
    try {
      await shell.openExternal(url)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IpcChannel.RetryBootstrap, async (): Promise<IpcResponse<void>> => {
    try {
      await startBackendAndConnect()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

/** Clean up backend and tray resources before quit or retry. */
async function cleanup(): Promise<void> {
  trayManager?.destroy()
  trayManager = undefined
  await dshProcess?.stop()
  dshProcess = undefined
}

/**
 * Boot the dsh backend and connect the shell window to it. Runs
 * asynchronously after the window opens; every failure path reports the
 * reason to the window (not a system dialog) so the user can read it and
 * retry. Never throws to the caller — failures render in-page.
 */
async function startBackendAndConnect(): Promise<void> {
  sendBootstrapStatus({ phase: 'loading' })
  logMain('bootstrap: starting')

  const port = await getFreePort()
  logMain(`bootstrap: port allocated (${String(port)})`)
  const apiKey = apiKeyStore?.getApiKey()
  // Keep dsh's profile and plugin state inside this app's user-data directory.
  // In particular, do not inherit DSH_HOME from the parent process: a stale or
  // partially installed global profile can make the backend fail before it
  // starts (for example, when it references a plugin package that is absent).
  const env: NodeJS.ProcessEnv = {
    DSH_HOME: join(app.getPath('userData'), 'dsh'),
  }
  if (apiKey !== undefined) env.DEEPSEEK_API_KEY = apiKey

  // Backend log file: the packaged Windows app has no console, so persist the
  // dsh child's output for post-mortem diagnosis. Truncated per launch.
  const backendLog = join(app.getPath('userData'), 'dsh-backend.log')
  try { writeFileSync(backendLog, `--- launch ${new Date().toISOString()} ---\n`) } catch { /* non-fatal */ }

  dshProcess = new DshProcess({ port, env, logFile: backendLog, logger: (line) => console.log(line) })
  dshProcess.start()
  logMain(`bootstrap: backend spawned (pid ${String(dshProcess.pid)})`)

  // Overall bootstrap timeout: abort the waits if dsh doesn't come up.
  const timeoutController = new AbortController()
  const bootstrapTimer = setTimeout(() => timeoutController.abort(), BOOTSTRAP_TIMEOUT_MS)

  /** Report an in-page failure and stop the backend. */
  const fail = (message: string, detail: string): void => {
    clearTimeout(bootstrapTimer)
    logMain(`bootstrap: failed — ${message}`)
    sendBootstrapStatus({ phase: 'error', message, detail })
    void dshProcess?.stop().then(() => { dshProcess = undefined })
  }

  let urlInfo
  try {
    urlInfo = await dshProcess.waitForUrl(timeoutController.signal)
  } catch (err) {
    fail(
      '后台服务启动失败',
      `${err instanceof Error ? err.message : String(err)}\n\n--- backend output (tail) ---\n${dshProcess?.getRecentOutput() ?? '(no output)'}`,
    )
    return
  }

  // The child exits with an empty URL when it dies before binding.
  if (urlInfo.port === 0) {
    fail(
      '后台服务启动失败',
      `The dsh web backend exited before it was ready.\n\n--- backend output (tail) ---\n${dshProcess?.getRecentOutput() ?? '(no output)'}`,
    )
    return
  }

  const url = `http://127.0.0.1:${String(urlInfo.port)}`
  logMain(`bootstrap: backend URL received (${url})`)

  try {
    await waitForReady({ url, timeoutMs: HTTP_READY_TIMEOUT_MS, signal: timeoutController.signal })
  } catch (err) {
    fail(
      '后台服务未就绪',
      `${err instanceof Error ? err.message : String(err)}\n\n--- backend output (tail) ---\n${dshProcess?.getRecentOutput() ?? '(no output)'}`,
    )
    return
  }

  clearTimeout(bootstrapTimer)
  logMain('bootstrap: HTTP ready, loading dsh web UI')

  if (shellWindow !== undefined && !shellWindow.isDestroyed()) {
    await shellWindow.loadURL(url)
  }
  logMain('bootstrap: complete')
}

/**
 * One-time app initialization: logging, API-key store, IPC, tray, and the
 * shell window; then the first backend boot runs in the background.
 */
async function bootstrap(): Promise<void> {
  initMainLog()

  apiKeyStore = new ApiKeyStore(
    app,
    safeStorage,
    readFileSync,
    writeFileSync,
    existsSync,
    join,
  )

  setupIpc()

  shellWindow = createShellWindow()

  trayManager = new TrayManager(
    {
      Tray,
      Menu,
      createIcon: () => {
        const iconPath = createTrayIcon()
        try { return nativeImage.createFromPath(iconPath) } catch { return iconPath }
      },
    },
    shellWindow,
  )
  trayManager.create()

  await startBackendAndConnect()
}

// Electron lifecycle wiring.

// Crash visibility: without these, an uncaught error in the main process
// kills it silently on packaged Windows (no console, no dialog) — the app
// just becomes a background process that never shows a window.
process.on('uncaughtException', (err) => {
  logMain(`uncaughtException: ${err.stack ?? err.message}`)
  try {
    dialog.showErrorBox('DeepSeek Harness — Unexpected Error', `${err.stack ?? err.message}`)
  } catch { /* dialog may be unavailable during teardown */ }
  app.exit(1)
})
process.on('unhandledRejection', (reason) => {
  logMain(`unhandledRejection: ${String(reason)}`)
})

// Prevent multiple instances.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    logMain('lifecycle: second-instance signaled')
    const win = BrowserWindow.getAllWindows()[0]
    if (win !== undefined) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    void bootstrap().catch((err) => {
      logMain(`bootstrap: unexpected error — ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
      sendBootstrapStatus({
        phase: 'error',
        message: '应用初始化失败',
        detail: String(err),
      })
    })
  })

  app.on('window-all-closed', () => {
    // On macOS, apps stay alive when all windows are closed; on other
    // platforms the app should quit and take the dsh child with it.
    if (process.platform !== 'darwin') {
      void cleanup().then(() => app.quit())
    }
  })

  app.on('before-quit', (event) => {
    event.preventDefault()
    void cleanup().then(() => app.exit(0))
  })
}
