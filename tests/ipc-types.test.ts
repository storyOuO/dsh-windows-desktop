import { describe, it, expect } from 'vitest'
import { IpcChannel, type IpcResponse } from '../electron/ipc-types'

describe('IpcChannel', () => {
  it('exposes all expected channel names', () => {
    expect(IpcChannel.GetApiKey).toBe('api-key:get')
    expect(IpcChannel.SetApiKey).toBe('api-key:set')
    expect(IpcChannel.DeleteApiKey).toBe('api-key:delete')
    expect(IpcChannel.OpenExternal).toBe('open-external')
  })

  it('IpcChannel values are unique', () => {
    const values = Object.values(IpcChannel)
    expect(new Set(values).size).toBe(values.length)
  })

  it('IpcResponse type is constructible', () => {
    const success: IpcResponse<string> = { ok: true, data: 'test' }
    expect(success.ok).toBe(true)
    expect(success.data).toBe('test')

    const failure: IpcResponse = { ok: false, error: 'something failed' }
    expect(failure.ok).toBe(false)
    expect(failure.error).toBe('something failed')
  })
})
