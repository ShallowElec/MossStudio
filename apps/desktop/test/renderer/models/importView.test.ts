import { describe, expect, it } from 'vitest'
import type { ModelImportFile, ModelImportState } from '@shared/types'
import { importModels, importProgress, importRow, importTitle } from '@renderer/pages/models/importView'
import { GPU_RTX_5090, catalogFixture, downloadFixture, gpuDeviceFixture } from '../../mocks/backend'

const place = { remote: false, gpus: [gpuDeviceFixture()], cliGpus: new Set<string>() }
const file = (patch: Partial<ModelImportFile>): ModelImportFile => ({
  path: '/m/file.safetensors',
  name: 'file.safetensors',
  sizeBytes: 1,
  state: 'done',
  ...patch,
})
const state = (patch: Partial<ModelImportState> = {}): ModelImportState => ({
  id: 'i',
  phase: 'done',
  files: [],
  models: [],
  choose: null,
  ...patch,
})

describe('importRow', () => {
  it('shows a spinner while the engine checks a file, then what it is', () => {
    expect(importRow(file({ state: 'checking' }), place)).toMatchObject({ busy: true, tag: null, line: null })
    expect(importRow(file({ kind: 'part', role: 'dit', precision: 'int8', catalogName: 'MOSS-Image SFT INT8' }), place)).toMatchObject({
      busy: false,
      tag: '模型的一部分',
      line: '认出来了：MOSS-Image SFT INT8',
    })
    expect(importRow(file({ kind: 'lora' }), place)).toMatchObject({ tag: 'LoRA', line: '已加入' })
    expect(importRow(file({ kind: 'control' }), place)).toMatchObject({ tag: '控制适配器', line: '已加入' })
    expect(importRow(file({ kind: 'source', app: 'comfyui' }), place)).toMatchObject({ tag: '模型目录', line: '已接入 ComfyUI' })
    expect(importRow(file({ kind: 'part', role: 'dit', converts: true }), place).line).toBe('第一次使用时要先转换，会多花一点时间')
  })

  it('says why a file cannot be used, with the one way out when there is one', () => {
    const fp16 = importRow(file({ kind: 'unusable', problem: 'fp16', offer: { bundleId: 'moss-sft-int8', label: '下载 INT8 版' } }), place)
    expect(fp16).toMatchObject({ unusable: true, tag: null, line: '这是 FP16 版本，引擎读不了。换成 INT8 版本就能用。' })
    expect(fp16.offer).toEqual({ bundleId: 'moss-sft-int8', label: '下载 INT8 版' })
    expect(importRow(file({ path: '/m/sd_xl_base_1.0.safetensors', kind: 'unusable', problem: 'not-moss' }), place).line).toBe(
      'sd_xl_base_1.0 不是 MOSS-Image 模型，MossStudio 用不了它。',
    )
  })

  it('an NVFP4 main model is unusable without an RTX 50, from the hardware the catalog names', () => {
    const nvfp4 = file({ kind: 'part', role: 'dit', precision: 'nvfp4', name: 'moss_image_sft_nvfp4.safetensors' })
    expect(importRow(nvfp4, place)).toMatchObject({ unusable: true, line: '这个版本只能在 RTX 50 系列显卡上用。' })
    expect(importRow(nvfp4, { ...place, gpus: [GPU_RTX_5090()] })).toMatchObject({ unusable: false, tag: '模型的一部分' })
  })

  it('a single file is unusable when every GPU runs 兼容模式', () => {
    const gpu = gpuDeviceFixture()
    expect(importRow(file({ kind: 'part', role: 'vae' }), { remote: false, gpus: [gpu], cliGpus: new Set([gpu.uuid]) })).toMatchObject({
      unusable: true,
      line: '这台电脑用兼容模式引擎，只能用完整的 BF16 模型文件夹。',
    })
  })
})

describe('importModels', () => {
  const catalog = catalogFixture({ installed: ['moss-sft-comfy-int8_convrot'] })

  it('offers the missing parts in one action, the runtime config folded in without being named', () => {
    const [model] = importModels(state({ models: [{ bundleId: 'moss-sft-int8', name: 'MOSS-Image SFT INT8' }] }), catalog, [], place)
    const missing = ['qwen35-comfy-int8_convrot', 'flux2-vae-comfy-small', 'moss-runtime-config']
      .map((id) => catalog.models.find((entry) => entry.id === id)!.sizeBytes)
      .reduce((sum, size) => sum + size, 0)
    expect(missing).toBe(10_017_695_993)
    expect(model).toMatchObject({ status: 'needs', action: '还缺文本编码器和 VAE · 下载 10 GB' })
  })

  it('says 可以用了 only for a model that is complete and can run here (B3)', () => {
    const ready = catalogFixture({
      installed: ['moss-sft-comfy-int8_convrot', 'qwen35-comfy-int8_convrot', 'flux2-vae-comfy-small', 'moss-runtime-config'],
    })
    const imported = state({ models: [{ bundleId: 'moss-sft-int8', name: 'MOSS-Image SFT INT8' }] })
    const models = importModels(imported, ready, [], place)
    expect(models[0]).toMatchObject({ status: 'ready' })
    expect(importTitle(imported, models)).toBe('可以用了：MOSS-Image SFT INT8')
    const nvfp4 = catalogFixture({
      installed: ['moss-sft-comfy-nvfp4', 'qwen35-comfy-int8_convrot', 'flux2-vae-comfy-small', 'moss-runtime-config'],
    })
    const blocked = importModels(state({ models: [{ bundleId: 'moss-sft-nvfp4', name: 'MOSS-Image SFT NVFP4' }] }), nvfp4, [], place)
    expect(blocked[0]).toMatchObject({ status: 'blocked', reason: '只能在 RTX 50 系列显卡上运行' })
    expect(importTitle(state({ models: [{ bundleId: 'moss-sft-nvfp4', name: 'x' }] }), blocked)).toBe('识别完了')
  })

  it('shows a download that is under way as progress', () => {
    // 下载 queues every missing part at once.
    const tasks = ['qwen35-comfy-int8_convrot', 'flux2-vae-comfy-small', 'moss-runtime-config'].map((id) =>
      downloadFixture({ id: `model:${id}`, targetId: id, state: 'running', bytes: 10, totalBytes: 100 }),
    )
    const [model] = importModels(state({ models: [{ bundleId: 'moss-sft-int8', name: 'x' }] }), catalog, tasks, place)
    expect(model).toMatchObject({ status: 'busy', action: null })
    expect(model!.progress?.stateText).toBe('下载中')
  })
})

describe('importTitle and importProgress', () => {
  it('counts the files while they are checked', () => {
    const checking = state({
      phase: 'checking',
      files: [file({}), file({ path: '/m/b', state: 'checking' }), file({ path: '/m/c', state: 'checking' })],
    })
    expect(importTitle(checking, [])).toBe('正在识别 3 个文件…')
    expect(importProgress(checking)).toEqual({ done: 1, total: 3, percent: 33 })
    expect(importTitle(null, [])).toBe('导入模型')
  })
})
