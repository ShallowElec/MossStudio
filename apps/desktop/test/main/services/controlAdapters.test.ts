import { readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Events } from '@shared/channels'
import { useTempDataRoot, useTempDir } from '@test/helpers/tempDir'

const emit = vi.hoisted(() => vi.fn())
vi.mock('@main/lib/events', () => ({ emit }))
// The shared model folders the list also reads need no engine here.
vi.mock('@main/services/engineInstalls', () => ({ localServerPath: () => null }))

const dataRoot = useTempDataRoot()
const models = useTempDir('mossstudio-control-')

let registry: typeof import('@main/services/controlAdapters')

function file(name: string): string {
  const path = join(models(), name)
  writeFileSync(path, 'weights')
  return path
}

beforeEach(async () => {
  vi.resetModules()
  emit.mockReset()
  registry = await import('@main/services/controlAdapters')
})

describe('control adapter registry', () => {
  it('registers a file the engine called a control adapter, with its kinds and base model', () => {
    const path = file('union.safetensors')
    const entry = registry.registerControlAdapter({ path, controlKinds: ['depth', 'canny', 'pose'], baseModel: 'moss-image' })
    expect(entry).toEqual({
      id: expect.stringMatching(/^control-[0-9a-f]{12}$/),
      name: 'union.safetensors',
      path,
      sizeBytes: 7,
      controlKinds: ['depth', 'canny', 'pose'],
      baseModel: 'moss-image',
      addedAt: expect.any(String),
    })
    expect(registry.listControlAdapters()).toEqual([entry])
    expect(JSON.parse(readFileSync(join(dataRoot(), 'control-adapters.json'), 'utf8'))).toEqual([entry])
    expect(emit).toHaveBeenCalledWith(Events.modelsChanged, null)
  })

  it('adding the same file again (also through a link) updates the one entry', () => {
    const path = file('union.safetensors')
    const first = registry.registerControlAdapter({ path, controlKinds: ['depth'] })
    // A file symlink needs a privilege on Windows; the same path is the same file there.
    const link = join(models(), 'link.safetensors')
    if (process.platform !== 'win32') symlinkSync(path, link)
    const second = registry.registerControlAdapter({ path: process.platform === 'win32' ? path : link, controlKinds: ['depth', 'canny'] })
    expect(second.id).toBe(first.id)
    expect(second.addedAt).toBe(first.addedAt)
    expect(registry.listControlAdapters()).toEqual([second])
  })

  it('refuses a file that is not there, in plain words', () => {
    expect(() => registry.registerControlAdapter({ path: join(models(), 'gone.safetensors'), controlKinds: [] })).toThrow(
      expect.objectContaining({ code: 'E_INPUT_PATH', message: '找不到这个文件，请重新选择' }),
    )
  })

  it('removes an entry by id and tells the renderer; an unknown id changes nothing', () => {
    const entry = registry.registerControlAdapter({ path: file('union.safetensors'), controlKinds: ['depth'] })
    emit.mockClear()
    expect(registry.removeControlAdapter({ id: 'nope' })).toBeNull()
    expect(emit).not.toHaveBeenCalled()
    registry.removeControlAdapter({ id: entry.id })
    expect(registry.listControlAdapters()).toEqual([])
    expect(emit).toHaveBeenCalledWith(Events.modelsChanged, null)
  })

  it('reads a damaged registry as empty and skips malformed entries', () => {
    writeFileSync(join(dataRoot(), 'control-adapters.json'), '{')
    expect(registry.listControlAdapters()).toEqual([])
    writeFileSync(
      join(dataRoot(), 'control-adapters.json'),
      JSON.stringify([{ id: 'x' }, { id: 'ok', name: 'a', path: '/a', sizeBytes: 1, controlKinds: ['depth'], addedAt: 't' }]),
    )
    expect(registry.listControlAdapters().map((entry) => entry.id)).toEqual(['ok'])
  })
})
