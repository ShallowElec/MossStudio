import { describe, expect, it } from 'vitest'
import {
  assembleImport,
  catalogFileMatch,
  fileStem,
  importProblemText,
  int8Instead,
  isModelFileName,
  lostFile,
  lostFileText,
  matchingFileBundle,
  recognize,
} from '@shared/modelImport'
import type { ModelEntry } from '@shared/types'
import { catalogFixture } from '../mocks/backend/fixtures'

const catalog = catalogFixture()

describe('recognize: what an inspect answer means', () => {
  it('names the role of a file the engine loads, with its precision as the catalog spells it', () => {
    expect(recognize({ kind: 'dit', loadable: true, precision: 'w4a4' }, 'moss_int4.safetensors')).toEqual({
      kind: 'dit',
      precision: 'int4',
    })
    expect(recognize({ kind: 'text_encoder', loadable: true, precision: 'int8' }, 'te.safetensors')).toEqual({
      kind: 'text_encoder',
      precision: 'int8',
    })
    expect(recognize({ kind: 'lora', loadable: true, base_model: 'moss-sft' }, 'style.safetensors')).toEqual({
      kind: 'lora',
      baseModel: 'moss-sft',
    })
    expect(recognize({ kind: 'control_adapter', loadable: true, control_kinds: ['depth', 3, 'canny'] }, 'c.safetensors')).toEqual({
      kind: 'control_adapter',
      controlKinds: ['depth', 'canny'],
    })
  })

  it('marks a GGUF main model the engine converts the first time it loads', () => {
    const report = { kind: 'dit', loadable: true, precision: 'int8', quantization: 'GGUF Q4_K + Q6_K + BF16 + F32, runs as INT8 ConvRot' }
    expect(recognize(report, 'moss-Q4_K_M.gguf')).toEqual({ kind: 'dit', precision: 'int8', converts: true })
  })

  it.each([
    [
      {
        kind: 'unknown',
        loadable: false,
        note: 'found block weights stored as F8_E4M3 (FP8), a quantization format the engine does not read',
      },
      'x.safetensors',
      'fp8',
    ],
    [{ kind: 'dit', loadable: false, note: 'NVFP4 needs an RTX 50 GPU (compute capability 12.0)' }, 'x.safetensors', 'nvfp4'],
    [{ kind: 'unknown', loadable: false, note: 'GGUF tensors of types the engine does not read: Q3_K' }, 'x.gguf', 'gguf'],
    [
      { kind: 'dit', loadable: false, note: 'block weights stored as F16, which the engine does not load as a DiT' },
      'x.safetensors',
      'fp16',
    ],
    [
      { kind: 'unknown', loadable: false, note: 'found a PyTorch pickle (.bin / .pt / .ckpt); the engine reads safetensors files' },
      'x.ckpt',
      'format',
    ],
    [{ kind: 'lora', loadable: false, note: 'a LoRA for another model' }, 'x.safetensors', 'lora-other'],
    [{ kind: 'dit', loadable: false, note: 'needs decoding: moss-infer quantize' }, 'x.safetensors', 'unsupported'],
    [{ kind: 'unknown', loadable: false, note: '' }, 'sd_xl_base_1.0.safetensors', 'not-moss'],
  ])('reads why the engine refused %j', (report, name, problem) => {
    expect(recognize(report, name)).toEqual({ kind: null, problem })
  })

  it('never takes BF16 in a note for FP16', () => {
    expect(recognize({ kind: 'dit', loadable: false, note: 'tensor stored as BF16 has the wrong shape' }, 'x.safetensors').problem).toBe(
      'unsupported',
    )
  })
})

describe('importProblemText', () => {
  it('says in one sentence why a file cannot be used, naming the file when that helps', () => {
    expect(importProblemText('not-moss', 'D:\\models\\sd_xl_base_1.0.safetensors')).toBe(
      'sd_xl_base_1.0 不是 MOSS-Image 模型，MossStudio 用不了它。',
    )
    expect(importProblemText('fp16', '/m/x.safetensors')).toBe('这是 FP16 版本，引擎读不了。换成 INT8 版本就能用。')
    expect(importProblemText('fp8', '/m/x.safetensors')).toBe('这是 FP8 版本，引擎读不了。可以改用 INT8 版本。')
    expect(importProblemText('nvfp4', '/m/x.safetensors')).toBe('这个版本只能在 RTX 50 系列显卡上用。')
    expect(importProblemText('gguf', '/m/x.gguf')).toBe('这种压缩格式引擎读不了。')
    expect(importProblemText('cli', '/m/x.safetensors')).toBe('这台电脑用兼容模式引擎，只能用完整的 BF16 模型文件夹。')
  })
})

describe('file names', () => {
  it('knows which files may be weights and drops the extension for display', () => {
    expect(['a.safetensors', 'b.GGUF', 'c.ckpt', 'd.sft'].every(isModelFileName)).toBe(true)
    expect(['notes.txt', 'picture.png', 'safetensors'].some(isModelFileName)).toBe(false)
    expect(fileStem('C:\\Models\\moss.image.v2.safetensors')).toBe('moss.image.v2')
  })
})

describe('catalogFileMatch', () => {
  it('matches a catalog single file by its file name and exact size, ignoring case and folders', () => {
    const int8 = catalog.models.find((model) => model.id === 'moss-sft-comfy-int8_convrot')!
    expect(catalogFileMatch({ name: 'MOSS_IMAGE_SFT_INT8_CONVROT.safetensors', sizeBytes: int8.sizeBytes }, catalog.models)?.id).toBe(
      int8.id,
    )
    expect(
      catalogFileMatch({ name: 'moss_image_sft_int8_convrot.safetensors', sizeBytes: int8.sizeBytes + 1 }, catalog.models),
    ).toBeUndefined()
    // The engine must agree on the role too.
    expect(
      catalogFileMatch({ name: 'moss_image_sft_int8_convrot.safetensors', sizeBytes: int8.sizeBytes }, catalog.models, 'vae'),
    ).toBeUndefined()
  })
})

describe('matchingFileBundle and int8Instead', () => {
  it('takes the single-file model a catalog main model is part of', () => {
    expect(matchingFileBundle({ name: 'x', catalogId: 'moss-sft-comfy-nvfp4' }, catalog.bundles, catalog.models)?.id).toBe('moss-sft-nvfp4')
  })

  it('matches an unknown main model by precision and flavour, else the everyday INT8 model', () => {
    expect(matchingFileBundle({ name: 'my-base-int8.safetensors', precision: 'int8' }, catalog.bundles, catalog.models)?.id).toBe(
      'moss-base-int8',
    )
    expect(matchingFileBundle({ name: 'finetune.safetensors', precision: 'int4' }, catalog.bundles, catalog.models)?.id).toBe(
      'moss-sft-int4',
    )
    expect(matchingFileBundle({ name: 'finetune.safetensors', precision: 'bf16' }, catalog.bundles, catalog.models)?.id).toBe(
      'moss-sft-int8',
    )
    expect(int8Instead('moss_image_base_fp16_fixed.safetensors', catalog.bundles, catalog.models)?.id).toBe('moss-base-int8')
  })
})

describe('assembleImport', () => {
  const dit = {
    id: 'moss-sft-comfy-int8_convrot',
    role: 'dit' as const,
    name: 'moss_image_sft_int8_convrot.safetensors',
    precision: 'int8',
    catalogId: 'moss-sft-comfy-int8_convrot',
  }

  it('makes the catalog model itself when every part is that model’s part, the missing ones to download', () => {
    expect(assembleImport([dit], catalog.bundles, catalog.models)).toEqual({
      steps: [{ kind: 'bundle', bundleId: 'moss-sft-int8' }],
      choose: null,
    })
  })

  it('saves a combination named after the catalog model with （我的文件） when an own part differs', () => {
    const vae = { id: 'local-scan-vae', role: 'vae' as const, name: 'my-vae.safetensors', precision: 'fp32' }
    expect(assembleImport([dit, vae], catalog.bundles, catalog.models).steps).toEqual([
      {
        kind: 'combination',
        name: 'MOSS-Image SFT INT8（我的文件）',
        components: { dit: dit.id, textEncoder: 'qwen35-comfy-int8_convrot', vae: 'local-scan-vae' },
      },
    ])
  })

  it('names a model of unknown files after the main model file', () => {
    const own = { id: 'local-scan-1', role: 'dit' as const, name: 'my-finetune.safetensors', precision: 'int8' }
    expect(assembleImport([own], catalog.bundles, catalog.models).steps).toEqual([
      {
        kind: 'combination',
        name: 'my-finetune',
        components: { dit: 'local-scan-1', textEncoder: 'qwen35-comfy-int8_convrot', vae: 'flux2-vae-comfy-small' },
      },
    ])
  })

  it('does not guess between two text encoders: 自己组合 opens with the first of each', () => {
    const encoders = [
      { id: 'te-a', role: 'text_encoder' as const, name: 'a.safetensors', precision: 'int8' },
      { id: 'te-b', role: 'text_encoder' as const, name: 'b.safetensors', precision: 'w4a8' },
    ]
    expect(assembleImport([dit, ...encoders], catalog.bundles, catalog.models)).toEqual({
      steps: [],
      choose: { dit: dit.id, textEncoder: 'te-a', vae: 'flux2-vae-comfy-small' },
    })
  })

  it('makes nothing of parts without a main model', () => {
    expect(assembleImport([{ id: 'v', role: 'vae', name: 'v.safetensors' }], catalog.bundles, catalog.models)).toEqual({
      steps: [],
      choose: null,
    })
  })
})

describe('lostFile', () => {
  const own: ModelEntry = {
    id: 'local-scan-1',
    name: 'moss_image_sft_int8.safetensors',
    provider: 'local',
    repo: 'E:\\Models\\moss_image_sft_int8.safetensors',
    revision: 'local',
    role: 'dit',
    format: 'comfyui',
    precision: 'int8',
    license: 'local',
    tags: ['local-import'],
    localPath: 'E:\\Models\\moss_image_sft_int8.safetensors',
    missingFile: 'drive',
    installed: false,
    installedBytes: 0,
    sizeBytes: 5e9,
  }
  const bundle = { components: { dit: 'local-scan-1', textEncoder: 'qwen35-comfy-int8_convrot', vae: 'flux2-vae-comfy-small' } }

  it('names the own file that is gone, where it was, and whether its disk is missing', () => {
    const lost = lostFile(bundle, [...catalog.models, own])!
    expect(lostFileText('我的模型', lost)).toBe(
      '找不到「moss_image_sft_int8」（E:\\Models\\moss_image_sft_int8.safetensors）。插上那块硬盘，或重新找到它。',
    )
    expect(lostFileText('我的模型', { ...lost, place: 'file' })).toBe(
      '找不到「moss_image_sft_int8」（E:\\Models\\moss_image_sft_int8.safetensors）。它被移动或删除了，重新找到它。',
    )
  })

  it('counts a shared folder’s file whose entry is gone, and nothing for a model that is all there', () => {
    expect(lostFile({ components: { ...bundle.components, dit: 'shared-abc' } }, catalog.models)).toEqual({
      name: null,
      path: null,
      place: 'file',
    })
    expect(lostFile(bundle, [...catalog.models, { ...own, installed: true, missingFile: undefined }])).toBeNull()
  })
})
