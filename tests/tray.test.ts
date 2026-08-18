import { describe, it, expect, vi } from 'vitest'
import { TrayManager } from '../electron/tray'
import type { TrayDeps, TrayLike } from '../electron/tray'
import type { BrowserWindow } from 'electron'

/** Create a mock BrowserWindow with the methods TrayManager uses. */
function createMockWindow(): BrowserWindow {
  return {
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
    isVisible: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
  } as unknown as BrowserWindow
}

/** Create a mock TrayLike that records all method calls. */
function createMockTrayInstance(): TrayLike & {
  _setToolTip: ReturnType<typeof vi.fn>
  _setContextMenu: ReturnType<typeof vi.fn>
  _on: ReturnType<typeof vi.fn>
  _destroy: ReturnType<typeof vi.fn>
} {
  const _setToolTip = vi.fn()
  const _setContextMenu = vi.fn()
  const _on = vi.fn()
  const _destroy = vi.fn()
  return {
    setToolTip: _setToolTip,
    setContextMenu: _setContextMenu,
    on: _on,
    destroy: _destroy,
    _setToolTip,
    _setContextMenu,
    _on,
    _destroy,
  }
}

/** Create mock TrayDeps with fake Tray and Menu constructors. */
function createMockDeps(): TrayDeps & { trayInstance: ReturnType<typeof createMockTrayInstance> } {
  const trayInstance = createMockTrayInstance()
  // Must use a regular function (not arrow) so `new` works.
  const TrayCtor = vi.fn(function () { return trayInstance }) as unknown as TrayDeps['Tray']
  const menuInstance = {}
  const MenuCtor = {
    buildFromTemplate: vi.fn(() => menuInstance),
  } as unknown as TrayDeps['Menu']
  return {
    Tray: TrayCtor,
    Menu: MenuCtor,
    createIcon: vi.fn(() => '/fake/icon.ico'),
    trayInstance,
  }
}

describe('TrayManager', () => {
  it('creates a tray with the icon', () => {
    const deps = createMockDeps()
    const win = createMockWindow()
    const manager = new TrayManager(deps, win)
    manager.create()
    expect(deps.Tray).toHaveBeenCalledWith('/fake/icon.ico')
    expect(deps.createIcon).toHaveBeenCalledOnce()
  })

  it('sets tooltip and context menu on the tray', () => {
    const deps = createMockDeps()
    const win = createMockWindow()
    const manager = new TrayManager(deps, win)
    manager.create()
    expect(deps.trayInstance._setToolTip).toHaveBeenCalledWith('DeepSeek Harness')
    expect(deps.Menu.buildFromTemplate).toHaveBeenCalledOnce()
  })

  it('context menu has Show, Hide, separator, and Quit', () => {
    const deps = createMockDeps()
    const win = createMockWindow()
    const manager = new TrayManager(deps, win)
    manager.create()
    const template = (deps.Menu.buildFromTemplate as ReturnType<typeof vi.fn>).mock.calls[0][0] as
      { label: string, type?: string, click?: () => void }[]
    const labels = template.map(item => item.label)
    expect(labels).toContain('Show')
    expect(labels).toContain('Hide')
    expect(labels).toContain('Quit')
    expect(template.some(item => item.type === 'separator')).toBe(true)
  })

  it('click handler shows the window when hidden', () => {
    const deps = createMockDeps()
    const win = createMockWindow()
    ;(win.isVisible as ReturnType<typeof vi.fn>).mockReturnValue(false)
    const manager = new TrayManager(deps, win)
    manager.create()
    // Find the click callback registered via tray.on('click', cb).
    const onCalls = deps.trayInstance._on.mock.calls
    const clickCall = onCalls.find(([ev]: string[]) => ev === 'click')
    expect(clickCall).toBeDefined()
    const clickHandler = clickCall![1] as () => void
    clickHandler()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
  })

  it('click handler hides the window when visible', () => {
    const deps = createMockDeps()
    const win = createMockWindow()
    ;(win.isVisible as ReturnType<typeof vi.fn>).mockReturnValue(true)
    const manager = new TrayManager(deps, win)
    manager.create()
    const onCalls = deps.trayInstance._on.mock.calls
    const clickCall = onCalls.find(([ev]: string[]) => ev === 'click')
    const clickHandler = clickCall![1] as () => void
    clickHandler()
    expect(win.hide).toHaveBeenCalled()
  })

  it('Show menu item shows the window', () => {
    const deps = createMockDeps()
    const win = createMockWindow()
    const manager = new TrayManager(deps, win)
    manager.create()
    const template = (deps.Menu.buildFromTemplate as ReturnType<typeof vi.fn>).mock.calls[0][0] as
      { label: string, click?: () => void }[]
    template.find(item => item.label === 'Show')?.click?.()
    expect(win.show).toHaveBeenCalled()
  })

  it('Hide menu item hides the window', () => {
    const deps = createMockDeps()
    const win = createMockWindow()
    const manager = new TrayManager(deps, win)
    manager.create()
    const template = (deps.Menu.buildFromTemplate as ReturnType<typeof vi.fn>).mock.calls[0][0] as
      { label: string, click?: () => void }[]
    template.find(item => item.label === 'Hide')?.click?.()
    expect(win.hide).toHaveBeenCalled()
  })

  it('Quit menu item closes the window', () => {
    const deps = createMockDeps()
    const win = createMockWindow()
    const manager = new TrayManager(deps, win)
    manager.create()
    const template = (deps.Menu.buildFromTemplate as ReturnType<typeof vi.fn>).mock.calls[0][0] as
      { label: string, click?: () => void }[]
    template.find(item => item.label === 'Quit')?.click?.()
    expect(win.close).toHaveBeenCalled()
  })

  it('destroy() destroys the tray', () => {
    const deps = createMockDeps()
    const win = createMockWindow()
    const manager = new TrayManager(deps, win)
    manager.create()
    manager.destroy()
    expect(deps.trayInstance._destroy).toHaveBeenCalled()
  })
})
