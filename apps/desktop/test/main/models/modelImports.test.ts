import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  readImportedModels,
  registerScannedModels,
  relocateImportedModel,
  removeImportedModel,
  verifyImportedModelFile,
} from '@main/services/modelImports'
import { useTempDir } from '@test/helpers/tempDir'

const tempDir = useTempDir('mossstudio-model-imports-')

async function put(path: string, content: string | Buffer): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
  return path
}
const indexFile = (): string => join(tempDir(), 'imports', 'index.json')

/** The record an older version wrote when it imported a file by hashing it; such records keep working. */
async function hashedRecord(file: string, role: 'dit' | 'text_encoder' | 'vae' = 'vae'): Promise<void> {
  const content = await readFile(file)
  const sha256 = createHash('sha256').update(content).digest('hex')
  const info = await stat(file)
  await mkdir(join(indexFile(), '..'), { recursive: true })
  await writeFile(
    indexFile(),
    JSON.stringify({
      schema_version: 2,
      models: [
        {
          id: `local-file-${sha256.slice(0, 20)}`,
          name: 'w.safetensors',
          path: file,
          relativePath: 'w.safetensors',
          sha256,
          size: info.size,
          mtimeMs: info.mtimeMs,
          role,
          importedAt: new Date(0).toISOString(),
        },
      ],
    }),
  )
}

describe('readImportedModels', () => {
  it('returns an empty list when the index does not exist', async () => {
    expect(await readImportedModels(join(tempDir(), 'none.json'))).toEqual([])
  })

  it.each([
    ['an unknown schema', { schema_version: 3, models: [] }],
    ['a non-array model list', { schema_version: 2, models: {} }],
    [
      'a record with a bad hash',
      {
        schema_version: 2,
        models: [{ id: 'a', name: 'a', path: '/a', relativePath: 'a', sha256: 'zz', size: 1, mtimeMs: 1, role: 'dit', importedAt: 'x' }],
      },
    ],
    [
      'a record with zero size',
      {
        schema_version: 2,
        models: [{ id: 'a', name: 'a', path: '/a', relativePath: 'a', size: 0, mtimeMs: 1, role: 'dit', importedAt: 'x' }],
      },
    ],
    [
      'a record with an unknown role',
      {
        schema_version: 1,
        models: [{ id: 'a', name: 'a', path: '/a', relativePath: 'a', size: 1, mtimeMs: 1, role: 'lora', importedAt: 'x' }],
      },
    ],
    [
      'a record with an unknown layout',
      {
        schema_version: 2,
        models: [{ id: 'a', name: 'a', path: '/a', relativePath: 'a', size: 1, mtimeMs: 1, role: 'dit', layout: 'x', importedAt: 'x' }],
      },
    ],
  ])('rejects %s', async (_label, index) => {
    await put(indexFile(), JSON.stringify(index))
    await expect(readImportedModels(indexFile())).rejects.toThrow('本地模型导入记录无效')
  })

  it('accepts schema 1 records without a hash', async () => {
    const record = { id: 'a', name: 'a', path: '/a', relativePath: 'a', size: 1, mtimeMs: 1, role: 'dit', importedAt: 'x' }
    await put(indexFile(), JSON.stringify({ schema_version: 1, models: [record] }))
    expect(await readImportedModels(indexFile())).toEqual([record])
  })

  it('propagates malformed JSON', async () => {
    await put(indexFile(), '{')
    await expect(readImportedModels(indexFile())).rejects.toThrow(SyntaxError)
  })
})

describe('removeImportedModel', () => {
  it('rejects an unknown id', async () => {
    await expect(removeImportedModel(indexFile(), 'nope')).rejects.toThrow('本地导入模型记录不存在')
  })
})

describe('registerScannedModels', () => {
  it('answers null in place of the id of a file that is gone', async () => {
    const dit = await put(join(tempDir(), 'c', 'dit.safetensors'), 'dit-weights')
    const result = await registerScannedModels(indexFile(), [
      { path: join(tempDir(), 'c', 'gone.safetensors'), role: 'vae' },
      { path: dit, role: 'dit' },
    ])
    const [record] = await readImportedModels(indexFile())
    expect(result.ids).toEqual([null, record!.id])
  })

  it('registers files in place without hashing and updates on re-registration', async () => {
    const dit = await put(join(tempDir(), 'c', 'diffusion_models', 'dit.safetensors'), 'dit-weights')
    const result = await registerScannedModels(indexFile(), [
      { path: dit, role: 'dit', layout: 'comfyui-single-file', relativePath: 'diffusion_models/dit.safetensors' },
    ])
    const [record] = await readImportedModels(indexFile())
    expect(result).toEqual({ added: 1, updated: 0, missing: [], ids: [record!.id] })
    expect(record).toMatchObject({
      name: 'dit.safetensors',
      path: dit,
      relativePath: 'diffusion_models/dit.safetensors',
      size: 11,
      role: 'dit',
      layout: 'comfyui-single-file',
    })
    expect(record!.sha256).toBeUndefined()
    expect(record!.id).toMatch(/^local-scan-[a-f0-9]{20}$/)

    await writeFile(dit, 'dit-weights-v2')
    const again = await registerScannedModels(indexFile(), [{ path: dit, role: 'full', name: 'renamed' }])
    expect(again).toEqual({ added: 0, updated: 1, missing: [], ids: [record!.id] })
    const [updated] = await readImportedModels(indexFile())
    expect(updated).toMatchObject({
      id: record!.id,
      importedAt: record!.importedAt,
      role: 'full',
      name: 'renamed',
      size: 14,
      layout: 'comfyui-single-file',
    })
  })

  it('reports missing, empty and directory paths and does not write an index for nothing', async () => {
    const empty = await put(join(tempDir(), 'empty.safetensors'), '')
    const result = await registerScannedModels(indexFile(), [
      { path: join(tempDir(), 'missing.safetensors'), role: 'vae' },
      { path: empty, role: 'vae' },
      { path: tempDir(), role: 'vae' },
    ])
    expect(result.added + result.updated).toBe(0)
    expect(result.missing).toHaveLength(3)
    await expect(readFile(indexFile())).rejects.toThrow()
  })

  it('keeps a hash an older version learned when the file is registered again', async () => {
    const models = join(tempDir(), 'models')
    const file = await put(join(models, 'vae', 'v.safetensors'), 'vae')
    await hashedRecord(file)
    const [imported] = await readImportedModels(indexFile())
    await registerScannedModels(indexFile(), [{ path: file, role: 'vae' }])
    const [after] = await readImportedModels(indexFile())
    expect(after!.id).toBe(imported!.id)
    expect(after!.sha256).toBe(imported!.sha256)
  })
})

describe('verifyImportedModelFile', () => {
  it('fails for a scanned record, a hash/size mismatch, a vanished file or changed content', async () => {
    const models = join(tempDir(), 'models')
    const file = await put(join(models, 'w.safetensors'), 'weights')
    await hashedRecord(file)
    const [record] = await readImportedModels(indexFile())
    const { sha256, size } = record as { sha256: string; size: number }
    expect(await verifyImportedModelFile(record!, sha256, size)).toBe(true)
    expect(await verifyImportedModelFile({ ...record!, sha256: undefined }, sha256, size)).toBe(false)
    expect(await verifyImportedModelFile(record!, 'f'.repeat(64), size)).toBe(false)
    expect(await verifyImportedModelFile(record!, sha256, size + 1)).toBe(false)
    await writeFile(file, 'WEIGHTS')
    await utimes(file, new Date(), new Date())
    expect(await verifyImportedModelFile(record!, sha256, size)).toBe(false)
    await rm(file)
    expect(await verifyImportedModelFile(record!, sha256, size)).toBe(false)
  })
})

describe('what the engine said about an imported file', () => {
  it('keeps the precision and the catalog part a file stands in for', async () => {
    const file = await put(join(tempDir(), 'models', 'moss_image_sft_int8_convrot.safetensors'), 'dit')
    await registerScannedModels(indexFile(), [
      { path: file, role: 'dit', layout: 'comfyui-single-file', precision: 'int8', catalogId: 'moss-sft-comfy-int8_convrot' },
    ])
    expect(await readImportedModels(indexFile())).toEqual([
      expect.objectContaining({ path: file, role: 'dit', precision: 'int8', catalogId: 'moss-sft-comfy-int8_convrot' }),
    ])
    // A catalog part's own copy is removed by the part's id.
    await removeImportedModel(indexFile(), 'moss-sft-comfy-int8_convrot')
    expect(await readImportedModels(indexFile())).toEqual([])
  })
})

describe('relocateImportedModel (重新找到…)', () => {
  it('points the record at the file where it is now and keeps its id', async () => {
    const before = await put(join(tempDir(), 'E', 'moss.safetensors'), 'dit')
    const { ids } = await registerScannedModels(indexFile(), [{ path: before, role: 'dit', precision: 'int8' }])
    await rm(join(tempDir(), 'E'), { recursive: true })
    const after = await put(join(tempDir(), 'F', 'moved', 'moss-renamed.safetensors'), 'dit-longer')
    const record = await relocateImportedModel(indexFile(), ids[0]!, after, { precision: 'w4a8', catalogId: null })
    expect(record).toMatchObject({
      id: ids[0],
      path: after,
      name: 'moss-renamed.safetensors',
      size: 10,
      precision: 'w4a8',
      inspected: true,
    })
    expect(await readImportedModels(indexFile())).toEqual([record])
  })

  it('finds the own copy of a catalog part by the part id, and refuses a folder', async () => {
    const file = await put(join(tempDir(), 'a', 'vae.safetensors'), 'vae')
    await registerScannedModels(indexFile(), [{ path: file, role: 'vae', catalogId: 'flux2-vae-comfy-small' }])
    const moved = await put(join(tempDir(), 'b', 'vae.safetensors'), 'vae')
    const facts = { catalogId: 'flux2-vae-comfy-small' }
    expect((await relocateImportedModel(indexFile(), 'flux2-vae-comfy-small', moved, facts)).path).toBe(moved)
    await expect(relocateImportedModel(indexFile(), 'flux2-vae-comfy-small', tempDir(), facts)).rejects.toThrow('请选择模型文件')
    await expect(relocateImportedModel(indexFile(), 'nope', moved, facts)).rejects.toThrow('本地导入模型记录不存在')
    // A file that is not that catalog part any more stops standing in for it.
    expect(await relocateImportedModel(indexFile(), 'flux2-vae-comfy-small', moved, { catalogId: null })).not.toHaveProperty('catalogId')
  })

  it('keeps one stand-in per catalog part, and relocates and removes that one only', async () => {
    const first = await put(join(tempDir(), 'a', 'vae.safetensors'), 'vae')
    const second = await put(join(tempDir(), 'b', 'vae.safetensors'), 'vae')
    await registerScannedModels(indexFile(), [{ path: first, role: 'vae', catalogId: 'flux2-vae-comfy-small' }])
    await registerScannedModels(indexFile(), [{ path: second, role: 'vae', catalogId: 'flux2-vae-comfy-small' }])
    // The newer file takes the part over; the older one is an own file again.
    const records = await readImportedModels(indexFile())
    expect(records.map((record) => [record.path, record.catalogId])).toEqual([
      [first, undefined],
      [second, 'flux2-vae-comfy-small'],
    ])
    await removeImportedModel(indexFile(), 'flux2-vae-comfy-small')
    expect((await readImportedModels(indexFile())).map((record) => record.path)).toEqual([first])
  })

  it('writes changes that arrive together one after the other, losing none', async () => {
    const files = await Promise.all(['a', 'b', 'c', 'd'].map((name) => put(join(tempDir(), `${name}.safetensors`), name)))
    await Promise.all(files.map((path) => registerScannedModels(indexFile(), [{ path, role: 'vae' }])))
    expect((await readImportedModels(indexFile())).map((record) => record.path).sort()).toEqual(files.sort())
  })
})
