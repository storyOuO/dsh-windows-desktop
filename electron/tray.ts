/**
 * System-tray integration: a tray icon with Show/Hide/Quit actions.
 * @module electron/tray
 */

import type { BrowserWindow, Tray, NativeImage, MenuItemConstructorOptions } from 'electron'

/** Minimal Tray-like object the TrayManager needs. */
export interface TrayLike {
  setToolTip(tip: string): void
  setContextMenu(menu: unknown): void
  on(event: string, cb: () => void): void
  destroy(): void
}

/** Minimal Tray constructor interface (for testability). */
export interface TrayConstructor {
  new (image: string | NativeImage): TrayLike
}

/** Minimal Menu constructor interface. */
export interface MenuConstructor {
  buildFromTemplate(template: MenuItemConstructorOptions[]): unknown
}

/** Electron modules we need, injected for testability. */
export interface TrayDeps {
  Tray: TrayConstructor
  Menu: MenuConstructor
  /** Creates a small icon image from a buffer or path. */
  createIcon: () => string | NativeImage
}

/**
 * Owns the system tray: icon, tooltip, click-to-toggle, and context menu.
 */
export class TrayManager {
  private tray: TrayLike | undefined

  constructor(
    private readonly deps: TrayDeps,
    private readonly window: BrowserWindow,
  ) {}

  /** Create the tray and wire its events. */
  create(): void {
    this.tray = new this.deps.Tray(this.deps.createIcon())
    this.tray.setToolTip('DeepSeek Harness')

    const menu = this.deps.Menu.buildFromTemplate([
      { label: 'Show', click: () => this.showWindow() },
      { label: 'Hide', click: () => this.window.hide() },
      { type: 'separator' },
      { label: 'Quit', click: () => this.window.close() },
    ])
    this.tray.setContextMenu(menu)
    this.tray.on('click', () => this.toggleWindow())
  }

  /** Toggle between visible and hidden. */
  private toggleWindow(): void {
    if (this.window.isVisible()) {
      this.window.hide()
    } else {
      this.showWindow()
    }
  }

  private showWindow(): void {
    this.window.show()
    this.window.focus()
  }

  /** Destroy the tray (call before app quit). */
  destroy(): void {
    this.tray?.destroy()
    this.tray = undefined
  }
}

/** Re-export for consumers that need the Tray type. */
export type { Tray }
