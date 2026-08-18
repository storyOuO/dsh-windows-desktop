/**
 * DeepSeek API key secure storage using Electron's safeStorage encryption.
 * Falls back to plaintext in dev when safeStorage is unavailable (e.g. on
 * Linux without a keyring); production Windows always has DPAPI.
 * @module electron/api-key
 */

import type { SafeStorage } from 'electron'

/** Storage keys in the persistent config.json. */
const KEY_ID = 'deepseek-api-key'

/** Minimal subset of Electron's app module we depend on. */
export interface AppLike {
  getPath(name: 'userData'): string
  setPath(name: 'userData', path: string): void
}

/** Minimal subset of Electron's safeStorage we depend on. */
export interface SafeStorageLike {
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
  isEncryptionAvailable(): boolean
}

/** JSON record persisted to disk. */
interface PersistedData {
  [KEY_ID]?: string
}

/**
 * Encrypted API-key store backed by a JSON file in userData.
 */
export class ApiKeyStore {
  private data: PersistedData = {}
  private loaded = false

  /**
   * @param app - Electron app for userData path.
   * @param safeStorage - Electron safeStorage for encryption.
   * @param readFileSync - fs.readFileSync (injected for testability).
   * @param writeFileSync - fs.writeFileSync (injected for testability).
   * @param existsSync - fs.existsSync (injected for testability).
   * @param join - path.join (injected for testability).
   */
  constructor(
    private readonly app: AppLike,
    private readonly safeStorage: SafeStorageLike,
    private readonly readFileSync: (path: string) => Buffer,
    private readonly writeFileSync: (path: string, data: string | Buffer) => void,
    private readonly existsSync: (path: string) => boolean,
    private readonly join: (...paths: string[]) => string,
  ) {}

  /** Lazily load the persisted JSON on first access. */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    const file = this.filePath()
    if (this.existsSync(file)) {
      try {
        const raw = this.readFileSync(file).toString('utf8')
        this.data = JSON.parse(raw) as PersistedData
      } catch {
        this.data = {}
      }
    }
  }

  /** Absolute path of the config file inside userData. */
  private filePath(): string {
    return this.join(this.app.getPath('userData'), 'config.json')
  }

  /**
   * Read and decrypt the stored API key.
   * @returns the plaintext key, or `undefined` when none is stored.
   */
  getApiKey(): string | undefined {
    this.ensureLoaded()
    const encryptedHex = this.data[KEY_ID]
    if (encryptedHex === undefined) return undefined
    try {
      const encrypted = Buffer.from(encryptedHex, 'hex')
      if (this.safeStorage.isEncryptionAvailable()) {
        return this.safeStorage.decryptString(encrypted)
      }
      return encrypted.toString('utf8')
    } catch {
      return undefined
    }
  }

  /**
   * Encrypt and persist the API key.
   * @param apiKey - plaintext key to store.
   */
  setApiKey(apiKey: string): void {
    this.ensureLoaded()
    let encryptedHex: string
    if (this.safeStorage.isEncryptionAvailable()) {
      const encrypted = this.safeStorage.encryptString(apiKey)
      encryptedHex = encrypted.toString('hex')
    } else {
      encryptedHex = Buffer.from(apiKey, 'utf8').toString('hex')
    }
    this.data[KEY_ID] = encryptedHex
    this.writeFileSync(this.filePath(), JSON.stringify(this.data, null, 2))
  }

  /** Delete the stored API key. */
  deleteApiKey(): void {
    this.ensureLoaded()
    delete this.data[KEY_ID]
    this.writeFileSync(this.filePath(), JSON.stringify(this.data, null, 2))
  }
}
