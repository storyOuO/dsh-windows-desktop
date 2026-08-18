/**
 * Preload script: exposes a minimal, safe API to the renderer via
 * contextBridge. The renderer (dsh web SPA) does not use this directly for
 * its agent features — those go through the HTTP /api gateway. This bridge
 * is for desktop-specific functions (API key management, external links).
 * @module electron/preload
 */

import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel, type IpcResponse } from './ipc-types'

/** The API exposed to `window.dshDesktop` in the renderer. */
export interface DesktopApi {
  getApiKey(): Promise<string | undefined>
  setApiKey(key: string): Promise<void>
  deleteApiKey(): Promise<void>
  openExternal(url: string): Promise<void>
}

const api: DesktopApi = {
  async getApiKey(): Promise<string | undefined> {
    const res = ipcRenderer.invoke(IpcChannel.GetApiKey) as Promise<IpcResponse<string | undefined>>
    const r = await res
    if (!r.ok) throw new Error(r.error ?? 'getApiKey failed')
    return r.data
  },
  async setApiKey(key: string): Promise<void> {
    const res = ipcRenderer.invoke(IpcChannel.SetApiKey, key) as Promise<IpcResponse<void>>
    const r = await res
    if (!r.ok) throw new Error(r.error ?? 'setApiKey failed')
  },
  async deleteApiKey(): Promise<void> {
    const res = ipcRenderer.invoke(IpcChannel.DeleteApiKey) as Promise<IpcResponse<void>>
    const r = await res
    if (!r.ok) throw new Error(r.error ?? 'deleteApiKey failed')
  },
  async openExternal(url: string): Promise<void> {
    const res = ipcRenderer.invoke(IpcChannel.OpenExternal, url) as Promise<IpcResponse<void>>
    const r = await res
    if (!r.ok) throw new Error(r.error ?? 'openExternal failed')
  },
}

contextBridge.exposeInMainWorld('dshDesktop', api)
