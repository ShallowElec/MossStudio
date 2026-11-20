import { safeStorage } from 'electron'
import { readJsonObject, writeJsonAtomic } from '../install/record'
import { paths } from '../lib/paths'

/**
 * Language-model API keys, encrypted with the system's secure storage like the Hugging Face
 * and GitHub tokens, one entry per provider id. ai/agent.json only says whether a key is saved;
 * the value never reaches the renderer, the LAN page or agent.json.
 */
const load = (): Record<string, string> => (readJsonObject(paths.aiCredentials()) ?? {}) as Record<string, string>

export function hasAiKey(id: string): boolean {
  return Boolean(load()[id])
}

export function getAiKey(id: string): string | undefined {
  const encrypted = load()[id]
  return encrypted ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : undefined
}

/**
 * Save or (with null) remove keys in one write. fsync'd: the key migration drops the plain
 * copies from agent.json only after this returns, so it must be on disk first.
 */
export function saveAiKeys(keys: Record<string, string | null>): void {
  const credentials = load()
  for (const [id, key] of Object.entries(keys)) {
    if (!key) {
      delete credentials[id]
      continue
    }
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    ) {
      throw new Error('系统安全存储不可用，无法保存 API Key')
    }
    credentials[id] = safeStorage.encryptString(key).toString('base64')
  }
  writeJsonAtomic(paths.aiCredentials(), credentials)
}
