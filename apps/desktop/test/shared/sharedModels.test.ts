import { describe, expect, it } from 'vitest'
import { duplicatesImportedFile, isSharedModelId } from '@shared/sharedModels'

describe('isSharedModelId', () => {
  it('knows shared weights by their id prefix', () => {
    expect(isSharedModelId('shared-0123abcd')).toBe(true)
    expect(isSharedModelId('local-scan-0123')).toBe(false)
    expect(isSharedModelId('moss-sft')).toBe(false)
  })
})

describe('duplicatesImportedFile', () => {
  const shared = { id: 'shared-1', provider: 'local', localPath: 'D:\\ComfyUI\\models\\vae\\vae.safetensors' } as const

  it('hides a shared file that is also registered, comparing Windows paths without case', () => {
    const registered = { id: 'local-scan-1', provider: 'local', localPath: 'd:\\comfyui\\models\\VAE\\vae.safetensors' } as const
    expect(duplicatesImportedFile(shared, [registered, shared])).toBe(true)
    expect(duplicatesImportedFile(registered, [registered, shared])).toBe(false)
  })

  it('keeps a shared file nothing else lists, and compares POSIX paths exactly', () => {
    expect(duplicatesImportedFile(shared, [shared])).toBe(false)
    const posix = { id: 'shared-2', provider: 'local', localPath: '/models/VAE.safetensors' } as const
    const other = { id: 'local-scan-2', provider: 'local', localPath: '/models/vae.safetensors' } as const
    expect(duplicatesImportedFile(posix, [posix, other])).toBe(false)
  })
})
