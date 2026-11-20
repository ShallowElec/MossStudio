import { mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Events } from '@shared/channels'
import type { ModelImportState } from '@shared/types'
import { useTempDataRoot, useTempDir } from '@test/helpers/tempDir'
import { writeCatalog } from './modelFixtures'

const mocks = vi.hoisted(() => ({
  server: '/engine/moss-server' as string | null,
  cli: false,
  inspect: vi.fn<(path: string) => Promise<Record<string, unknown>>>(),
  running: 0,
  most: 0,
  emit: vi.fn(),
  release: vi.fn<() => string | null>(),
}))
vi.mock('@main/lib/content', () => ({ contentDir: mocks.release, catalogOverrideDir: () => mocks.release() }))
vi.mock('@main/services/supervisor', () => ({ listJobs: async () => [] }))
vi.mock('@main/services/network', () => ({ getLastNetwork: () => null }))
vi.mock('@main/services/hfNetwork', () => ({ fetchHf: (url: string) => fetch(url) }))
vi.mock('@main/lib/events', () => ({ emit: mocks.emit }))
vi.mock('@main/services/engineInstalls', () => ({
  localServerPath: () => mocks.server,
  deviceEngines: () => (mocks.cli ? [{ gpu: { id: 'GPU-CLI' }, engine: { package: { kind: 'vulkan' } }, memorySkipped: false }] : []),
  deviceRunsCli: () => mocks.cli,
}))
vi.mock('@main/lib/probeEngine', () => ({
  // One sidecar per check, as main runs it: hello first, then the inspects.
  withEngineRequests: async (
    _server: string,
    task: (request: (method: string, params: { path: string }) => Promise<unknown>) => Promise<unknown>,
  ) =>
    task(async (_method, { path }) => {
      mocks.running += 1
      mocks.most = Math.max(mocks.most, mocks.running)
      try {
        await new Promise((done) => setTimeout(done, 5))
        return await mocks.inspect(path)
      } finally {
        mocks.running -= 1
      }
    }),
}))

const dataRoot = useTempDataRoot()
const disk = useTempDir('mossstudio-own-models-')
const packaged = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../resources/models.json'), 'utf8')) as Record<string, unknown>

let service: typeof import('@main/services/modelImport')
let models: typeof import('@main/services/models')

/** A file of exactly this size without writing its bytes (a sparse file), so a 5.4 GB catalog file is cheap. */
function weights(path: string, size = 64): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
  truncateSync(path, size)
  return path
}

/** What `inspect` answers, per file name. */
const ANSWERS: Record<string, Record<string, unknown>> = {
  'moss_image_sft_int8_convrot.safetensors': { kind: 'dit', loadable: true, precision: 'int8' },
  'my-finetune.safetensors': { kind: 'dit', loadable: true, precision: 'int8' },
  'qwen-int8.safetensors': { kind: 'text_encoder', loadable: true, precision: 'int8' },
  'qwen-w4a8.safetensors': { kind: 'text_encoder', loadable: true, precision: 'w4a8' },
  'vae.safetensors': { kind: 'vae', loadable: true },
  'style.safetensors': { kind: 'lora', loadable: true, base_model: 'moss-sft' },
  'depth.safetensors': { kind: 'control_adapter', loadable: true, control_kinds: ['depth'] },
  'sd_xl_base_1.0.safetensors': { kind: 'unknown', loadable: false, note: 'not a MOSS-Image model' },
  'moss_image_sft_fp8.safetensors': { kind: 'unknown', loadable: false, note: 'found block weights stored as F8_E4M3 (FP8)' },
}

async function finished(): Promise<ModelImportState> {
  await vi.waitFor(() => expect(service.modelImportState()?.phase).toBe('done'))
  return service.modelImportState()!
}

beforeEach(async () => {
  vi.resetModules()
  mocks.server = '/engine/moss-server'
  mocks.cli = false
  mocks.running = 0
  mocks.most = 0
  mocks.emit.mockReset()
  mocks.inspect.mockReset().mockImplementation(async (path) => {
    const answer = ANSWERS[path.split(/[\\/]/).pop()!]
    if (!answer) throw new Error('io: cannot read')
    return { path, ...answer }
  })
  const release = join(dataRoot(), 'release')
  writeCatalog(release, packaged)
  mocks.release.mockReturnValue(release)
  const settings = await import('@main/services/settings')
  settings.updateSettings({ modelsRoot: join(dataRoot(), 'models') })
  models = await import('@main/services/models')
  service = await import('@main/services/modelImport')
})

describe('导入模型', () => {
  it('asks the engine about every file, two at a time, and puts each where it belongs', async () => {
    const int8 = weights(join(disk(), 'ComfyUI', 'diffusion_models', 'moss_image_sft_int8_convrot.safetensors'), 5_413_698_958)
    const lora = weights(join(disk(), 'loras', 'style.safetensors'))
    const control = weights(join(disk(), 'control', 'depth.safetensors'))
    const other = weights(join(disk(), 'sd_xl_base_1.0.safetensors'))
    await service.startModelImport([int8, lora, control, other])
    const state = await finished()
    expect(mocks.most).toBe(2)
    expect(state.phase).toBe('done')
    expect(state.files.map(({ name, kind }) => [name, kind])).toEqual([
      ['moss_image_sft_int8_convrot.safetensors', 'part'],
      ['style.safetensors', 'lora'],
      ['depth.safetensors', 'control'],
      ['sd_xl_base_1.0.safetensors', 'unusable'],
    ])
    // Same name and size as the catalog file: it is that part, recognised by its catalog name.
    expect(state.files[0]).toMatchObject({ catalogName: 'MOSS-Image SFT INT8', entryId: 'moss-sft-comfy-int8_convrot', precision: 'int8' })
    expect(state.files[3]).toMatchObject({ problem: 'not-moss' })
    // The catalog model it belongs to is the result; its other parts are still to download.
    expect(state.models).toEqual([{ bundleId: 'moss-sft-int8', name: 'MOSS-Image SFT INT8' }])
    const catalog = await models.getCatalog((await import('@main/services/settings')).getSettings(), true)
    expect(catalog.models.find((model) => model.id === 'moss-sft-comfy-int8_convrot')).toMatchObject({ installed: true, localPath: int8 })
    expect(catalog.adapters.find((adapter) => adapter.repo === lora)).toMatchObject({ installed: true, tags: ['local-file'] })
    expect((await import('@main/services/controlAdapters')).listControlAdapters()).toEqual([
      expect.objectContaining({ path: control, controlKinds: ['depth'] }),
    ])
    expect(mocks.emit).toHaveBeenCalledWith(Events.modelImport, expect.objectContaining({ phase: 'done' }))
  })

  it('makes one model of a main model, a text encoder and a VAE that came together, once however often they are imported', async () => {
    const files = ['my-finetune.safetensors', 'qwen-int8.safetensors', 'vae.safetensors'].map((name) => weights(join(disk(), 'mine', name)))
    await service.startModelImport(files)
    const first = await finished()
    expect(first.models).toEqual([{ bundleId: expect.stringMatching(/^combo-/), name: 'my-finetune' }])
    const combinations = (await import('@main/services/modelCombinations')).listCombinations()
    expect(combinations).toHaveLength(1)
    // B6: the same files again are the same model, not a copy.
    await service.startModelImport(files)
    const again = await finished()
    expect(again.models).toEqual(first.models)
    expect((await import('@main/services/modelCombinations')).listCombinations()).toHaveLength(1)
  })

  it('opens 自己组合 instead of guessing between two text encoders', async () => {
    const files = ['my-finetune.safetensors', 'qwen-int8.safetensors', 'qwen-w4a8.safetensors'].map((name) =>
      weights(join(disk(), 'two', name)),
    )
    await service.startModelImport(files)
    const state = await finished()
    expect(state.models).toEqual([])
    expect(state.choose).toEqual({
      dit: expect.stringMatching(/^local-scan-/),
      textEncoder: expect.stringMatching(/^local-scan-/),
      vae: 'flux2-vae-comfy-small',
    })
  })

  it('offers the INT8 version for an FP8 file, and makes no model of an unusable one (B3)', async () => {
    await service.startModelImport([weights(join(disk(), 'moss_image_sft_fp8.safetensors'))])
    const state = await finished()
    expect(state.files[0]).toMatchObject({ kind: 'unusable', problem: 'fp8', offer: { bundleId: 'moss-sft-int8', label: '下载 INT8 版' } })
    expect(state.models).toEqual([])
  })

  it('waits for an engine, and checks the files by itself once one is installed', async () => {
    mocks.server = null
    const file = weights(join(disk(), 'loras', 'style.safetensors'))
    await service.startModelImport([file])
    await vi.waitFor(() => expect(service.modelImportState()?.phase).toBe('waiting-engine'))
    expect(service.modelImportState()!.files[0]!.state).toBe('waiting')
    expect(mocks.inspect).not.toHaveBeenCalled()
    mocks.server = '/engine/moss-server'
    service.resumeModelImport()
    expect((await finished()).files[0]).toMatchObject({ state: 'done', kind: 'lora' })
  })

  it('says a computer running only 兼容模式 cannot use single files', async () => {
    mocks.server = null
    mocks.cli = true
    await service.startModelImport([weights(join(disk(), 'vae.safetensors'))])
    expect((await finished()).files[0]).toMatchObject({ kind: 'unusable', problem: 'cli' })
  })

  it('checks a file dropped twice once, and refuses a dropped network place', async () => {
    const file = weights(join(disk(), 'vae.safetensors'))
    await service.startModelImport([file, file, '\\\\nas\\models\\vae.safetensors'])
    const state = await finished()
    expect(state.files.map((item) => [item.name, item.kind, item.problem])).toEqual([
      ['vae.safetensors', 'part', undefined],
      ['vae.safetensors', 'unusable', 'network'],
    ])
    expect(mocks.inspect).toHaveBeenCalledTimes(1)
  })

  it('adds a ComfyUI install as a shared model folder instead of importing its files one by one', async () => {
    const comfy = join(disk(), 'ComfyUI')
    mkdirSync(join(comfy, 'models'), { recursive: true })
    for (const name of ['main.py', 'folder_paths.py']) writeFileSync(join(comfy, name), '')
    const onSourceAdded = vi.fn()
    await service.startModelImport([comfy], { hooks: { onSourceAdded } })
    const state = await finished()
    expect(state.files).toEqual([expect.objectContaining({ kind: 'source', app: 'comfyui', path: comfy })])
    expect((await import('@main/services/settings')).getSettings().modelSources).toEqual([
      expect.objectContaining({ kind: 'comfyui', path: comfy }),
    ])
    expect(onSourceAdded).toHaveBeenCalledTimes(1)
  })

  it('imports the model files in another folder, and says when a folder holds none', async () => {
    const folder = join(disk(), 'downloads')
    weights(join(folder, 'a', 'vae.safetensors'))
    writeFileSync(join(folder, 'readme.txt'), 'x')
    mkdirSync(join(disk(), 'empty'))
    await service.startModelImport([folder, join(disk(), 'empty')])
    const state = await finished()
    expect(state.files.map((item) => [item.name, item.kind, item.problem])).toEqual([
      ['vae.safetensors', 'part', undefined],
      ['empty', 'unusable', 'empty-folder'],
    ])
  })
})

describe('重新找到… and 移除', () => {
  async function ownModel(): Promise<{ bundleId: string; dit: string }> {
    const files = ['my-finetune.safetensors', 'qwen-int8.safetensors', 'vae.safetensors'].map((name) => weights(join(disk(), 'E', name)))
    await service.startModelImport(files)
    return { bundleId: (await finished()).models[0]!.bundleId, dit: files[0]! }
  }
  const catalog = async () => models.getCatalog((await import('@main/services/settings')).getSettings(), true)

  it('points a moved own file at where it is now; the engine has to agree it is the same kind of part', async () => {
    const { bundleId, dit } = await ownModel()
    rmSync(dit)
    const moved = weights(join(disk(), 'F', 'my-finetune.safetensors'))
    const lost = (await catalog()).models.find((model) => model.localPath === dit)!
    expect(lost).toMatchObject({ installed: false, missingFile: 'file' })
    await expect(service.relocateBundle(bundleId, async () => weights(join(disk(), 'F', 'vae.safetensors')))).rejects.toMatchObject({
      code: 'E_WRONG_FILE',
      message: '这个文件不是主模型，请选原来那个文件',
    })
    const pick = vi.fn(async () => moved)
    expect(await service.relocateBundle(bundleId, pick)).toEqual({ found: 1 })
    expect(pick).toHaveBeenCalledWith('重新找到「my-finetune.safetensors」', join(disk(), 'E'))
    expect((await catalog()).models.find((model) => model.id === lost.id)).toMatchObject({ installed: true, localPath: moved })
  })

  it('移除 drops the moved file and the combination, and leaves every file where it is', async () => {
    const { bundleId, dit } = await ownModel()
    rmSync(dit)
    await service.forgetBundle(bundleId)
    const after = await catalog()
    expect(after.bundles.some((bundle) => bundle.id === bundleId)).toBe(false)
    expect(after.models.some((model) => model.localPath === dit)).toBe(false)
    expect(readFileSync(join(disk(), 'E', 'vae.safetensors')).length).toBe(64)
  })
})
