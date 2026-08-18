import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ApiKeyStore } from '../electron/api-key'
import type { AppLike, SafeStorageLike } from '../electron/api-key'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

/** Create an in-memory mock of SafeStorage. */
function createMockSafeStorage(available: boolean = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (encrypted: Buffer) => {
      const str = encrypted.toString('utf8')
      if (str.startsWith('enc:')) return str.slice(4)
      return str
    },
  }
}

/** Create an ApiKeyStore backed by a temp directory. */
function createStore(
  safeStorage: SafeStorageLike = createMockSafeStorage(),
  existingData?: Record<string, unknown>,
): { store: ApiKeyStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-test-'))
  const app: AppLike = {
    getPath: () => dir,
    setPath: () => {},
  }
  if (existingData !== undefined) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(existingData))
  }
  const store = new ApiKeyStore(
    app,
    safeStorage,
    (path) => readFileSync(path),
    (path, data) => writeFileSync(path, data),
    existsSync,
    join,
  )
  return { store, dir }
}

describe('ApiKeyStore', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  it('returns undefined when no key is stored', () => {
    const { store } = createStore()
    expect(store.getApiKey()).toBeUndefined()
  })

  it('stores and retrieves an API key', () => {
    const { store } = createStore()
    store.setApiKey('sk-test-12345')
    expect(store.getApiKey()).toBe('sk-test-12345')
  })

  it('persists the key to disk as encrypted hex', () => {
    const { store, dir } = createStore()
    store.setApiKey('sk-secret-key')
    const configPath = join(dir, 'config.json')
    expect(existsSync(configPath)).toBe(true)
    const raw = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(raw['deepseek-api-key']).toMatch(/^[0-9a-f]+$/)
    // The plaintext should not appear in the file.
    expect(raw['deepseek-api-key']).not.toContain('sk-secret-key')
  })

  it('deletes the stored key', () => {
    const { store } = createStore()
    store.setApiKey('sk-to-delete')
    expect(store.getApiKey()).toBe('sk-to-delete')
    store.deleteApiKey()
    expect(store.getApiKey()).toBeUndefined()
  })

  it('overwrites the previous key on re-set', () => {
    const { store } = createStore()
    store.setApiKey('sk-first')
    store.setApiKey('sk-second')
    expect(store.getApiKey()).toBe('sk-second')
  })

  it('reads a key that was previously persisted to disk by another instance', () => {
    // First instance writes an encrypted key to disk.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-test-'))
    dirs.push(dir)
    const app1: AppLike = { getPath: () => dir, setPath: () => {} }
    const store1 = new ApiKeyStore(
      app1, createMockSafeStorage(), readFileSync, writeFileSync, existsSync, join,
    )
    store1.setApiKey('sk-persisted')

    // Second instance (same dir) reads it back.
    const app2: AppLike = { getPath: () => dir, setPath: () => {} }
    const store2 = new ApiKeyStore(
      app2, createMockSafeStorage(), readFileSync, writeFileSync, existsSync, join,
    )
    expect(store2.getApiKey()).toBe('sk-persisted')
  })

  it('falls back to plaintext when safeStorage is unavailable', () => {
    const { store } = createStore(createMockSafeStorage(false))
    store.setApiKey('sk-plaintext')
    expect(store.getApiKey()).toBe('sk-plaintext')
  })

  it('returns undefined on corrupted data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-test-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'config.json'), 'not-json')
    const app: AppLike = { getPath: () => dir, setPath: () => {} }
    const store = new ApiKeyStore(
      app,
      createMockSafeStorage(),
      (p) => readFileSync(p),
      (p, d) => writeFileSync(p, d),
      existsSync,
      join,
    )
    expect(store.getApiKey()).toBeUndefined()
  })

  it('handles empty string key gracefully', () => {
    const { store } = createStore()
    store.setApiKey('')
    expect(store.getApiKey()).toBe('')
  })

  it('returns undefined when decrypt fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-test-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ 'deepseek-api-key': 'deadbeef' }))
    const app: AppLike = { getPath: () => dir, setPath: () => {} }
    const brokenSafeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.from('enc'),
      decryptString: () => { throw new Error('decrypt failed') },
    }
    const store = new ApiKeyStore(
      app,
      brokenSafeStorage,
      (p) => readFileSync(p),
      (p, d) => writeFileSync(p, d),
      existsSync,
      join,
    )
    expect(store.getApiKey()).toBeUndefined()
  })
})
