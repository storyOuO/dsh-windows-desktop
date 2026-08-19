/**
 * Electron main process entry: orchestrates the dsh web child process, the
 * BrowserWindow, the system tray, and the API-key IPC bridge. This is the
 * only module that imports 'electron' directly; all others take injected
 * dependencies for testability.
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
import { IpcChannel, type IpcResponse } from './ipc-types'

/** Default window dimensions. */
const WINDOW_WIDTH = 1280
const WINDOW_HEIGHT = 800

/** Minimum window dimensions. */
const MIN_WIDTH = 800
const MIN_HEIGHT = 600

/** Timeout for the entire bootstrap (dsh start + URL + HTTP ready): 120 s — Cordis plugin tree with 50+ plugins can be slow on Windows. */
const BOOTSTRAP_TIMEOUT_MS = 120_000

/** Force-show the window after this long even if ready-to-show never fires (GPU/compositor quirks on some Windows machines). */
const FORCE_SHOW_MS = 10_000

let dshProcess: DshProcess | undefined
let trayManager: TrayManager | undefined
let apiKeyStore: ApiKeyStore | undefined

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
 * Called as the first step of bootstrap().
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
 * Create the main BrowserWindow and return it.
 * @param url - the URL to load (dsh web).
 */
function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    icon: getIconPath(),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => {
    logMain('window: ready-to-show fired, showing window')
    win.show()
  })
  // Fallback: some Windows GPU/compositor configurations never emit
  // ready-to-show, which would leave the app as a silent background process.
  // Force-show so the user at least sees the window state.
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      logMain('window: ready-to-show did not fire within 10 s, force-showing')
      win.show()
    }
  }, FORCE_SHOW_MS)
  win.webContents.on('did-fail-load', (_event, code, description, failedUrl) => {
    logMain(`window: did-fail-load code=${String(code)} desc=${description} url=${failedUrl}`)
  })
  win.loadURL(url).catch((err: unknown) => {
    logMain(`window: loadURL rejected: ${err instanceof Error ? err.message : String(err)}`)
  })
  return win
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

/** Wire the API-key IPC handlers. */
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
}

/** Clean up all resources before quit. */
async function cleanup(): Promise<void> {
  trayManager?.destroy()
  trayManager = undefined
  await dshProcess?.stop()
  dshProcess = undefined
}

/**
 * Show a fatal error dialog and quit. Used when the dsh backend fails to
 * start — the user sees a clear message instead of a blank white window.
 * When a dsh child process exists, its recent output tail is appended so
 * the dialog carries the backend's actual failure reason (the packaged
 * Windows app has no console to see it in).
 * @param title - dialog title.
 * @param message - error details.
 */
function fatalDialog(title: string, message: string): void {
  const tail = dshProcess?.getRecentOutput() ?? '(backend not started)'
  const full = `${message}\n\n--- backend output (tail) ---\n${tail}`
  console.error(`${title}: ${full}`)
  dialog.showErrorBox(title, full)
  void cleanup().then(() => app.quit())
}

/**
 * App entry: allocate a port, start dsh, wait for it, show the window.
 * Runs after Electron's `ready` event. A bootstrap timeout prevents the app
 * from hanging indefinitely if the dsh backend fails to start.
 */
async function bootstrap(): Promise<void> {
  initMainLog()
  logMain('bootstrap: starting')

  apiKeyStore = new ApiKeyStore(
    app,
    safeStorage,
    readFileSync,
    writeFileSync,
    existsSync,
    join,
  )

  setupIpc()

  const port = await getFreePort()
  logMain(`bootstrap: port allocated (${String(port)})`)
  const apiKey = apiKeyStore.getApiKey()
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

  // Overall bootstrap timeout: if dsh doesn't come up within the window,
  // show an error dialog instead of hanging with a blank window.
  const timeoutController = new AbortController()
  const bootstrapTimer = setTimeout(() => timeoutController.abort(), BOOTSTRAP_TIMEOUT_MS)

  let urlInfo
  try {
    urlInfo = await dshProcess.waitForUrl(timeoutController.signal)
  } catch (err) {
    clearTimeout(bootstrapTimer)
    const msg = err instanceof Error ? err.message : String(err)
    fatalDialog(
      'DeepSeek Harness — Backend Failed to Start',
      `The dsh web backend did not start within ${String(BOOTSTRAP_TIMEOUT_MS / 1000)} seconds.\n\n${msg}`,
    )
    return
  }

  // If the child exited immediately and returned an empty URL, treat as failure.
  if (urlInfo.port === 0) {
    clearTimeout(bootstrapTimer)
    fatalDialog(
      'DeepSeek Harness — Backend Failed to Start',
      'The dsh web backend exited before it was ready. Check the application logs for details.',
    )
    return
  }

  const url = `http://127.0.0.1:${String(urlInfo.port)}`
  logMain(`bootstrap: backend URL received (${url})`)

  // Wait for HTTP readiness (the URL line means the server is listening).
  try {
    await waitForReady({ url, timeoutMs: 90_000, signal: timeoutController.signal })
  } catch (err) {
    clearTimeout(bootstrapTimer)
    const msg = err instanceof Error ? err.message : String(err)
    fatalDialog(
      'DeepSeek Harness — Backend Not Ready',
      `The dsh web backend started but did not respond to HTTP.\n\n${msg}`,
    )
    return
  }

  clearTimeout(bootstrapTimer)
  logMain('bootstrap: HTTP ready, creating window')

  const win = createWindow(url)

  trayManager = new TrayManager(
    {
      Tray,
      Menu,
      createIcon: () => {
        const iconPath = createTrayIcon()
        try { return nativeImage.createFromPath(iconPath) } catch { return iconPath }
      },
    },
    win,
  )
  trayManager.create()
  logMain('bootstrap: complete')
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
      const msg = err instanceof Error ? err.message : String(err)
      fatalDialog('DeepSeek Harness — Startup Error', msg)
    })
  })

  app.on('window-all-closed', () => {
    // On macOS, apps stay alive when all windows are closed; on other
    // platforms the app should quit and take the dsh child with it.
    if (process.platform !== 'darwin') {
      void cleanup().then(() => app.quit())
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void bootstrap().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        fatalDialog('DeepSeek Harness — Startup Error', msg)
      })
    }
  })

  app.on('before-quit', (event) => {
    event.preventDefault()
    void cleanup().then(() => app.exit(0))
  })
}
