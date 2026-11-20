import type { ModelEntry } from './types'

/** Ids of weights found in a shared model folder (ComfyUI, SD WebUI, Forge or a custom folder) and loaded in place. */
export const SHARED_MODEL_PREFIX = 'shared-'

export function isSharedModelId(id: string): boolean {
  return id.startsWith(SHARED_MODEL_PREFIX)
}

/** Windows paths compare case-insensitively; `shared` cannot ask the OS, so a drive letter decides. */
function pathKey(path: string): string {
  return /^[a-z]:[\\/]/i.test(path) ? path.toLowerCase() : path
}

/**
 * A shared file that is also registered through 用电脑上的模型文件: lists show it once,
 * as the registration, while both ids keep resolving for combinations saved with either.
 */
export function duplicatesImportedFile(
  model: Pick<ModelEntry, 'id' | 'localPath'>,
  models: readonly Pick<ModelEntry, 'id' | 'provider' | 'localPath'>[],
): boolean {
  if (!isSharedModelId(model.id) || !model.localPath) return false
  const key = pathKey(model.localPath)
  return models.some(
    (other) =>
      other.provider === 'local' && !isSharedModelId(other.id) && other.localPath !== undefined && pathKey(other.localPath) === key,
  )
}
