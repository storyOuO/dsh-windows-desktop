/**
 * Shared IPC types between main process and preload/renderer.
 * @module electron/ipc-types
 */

/** Channels for the main↔preload bridge. */
export const IpcChannel = {
  GetApiKey: 'api-key:get',
  SetApiKey: 'api-key:set',
  DeleteApiKey: 'api-key:delete',
  OpenExternal: 'open-external',
} as const

export type IpcChannel = typeof IpcChannel[keyof typeof IpcChannel]

/** Response envelope for IPC calls. */
export interface IpcResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}
