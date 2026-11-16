/**
 * The `--weights` folder of a local run. The INT8 base parts are linked into a ComfyUI models
 * layout under the names the trainer looks for; the bf16 base goes as the diffusers folder the
 * engine already uses (the trainer reads the HF layout too).
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Settings } from '@shared/types'
import { codedError } from '../../lib/codedError'
import { paths } from '../../lib/paths'
import { bundleBinding, prepareModelBundle } from '../modelBundles'
import { fileSize, linkInPlace, safePath } from '../modelFiles'
import { componentSnapshot } from '../models'
import { COMFY_WEIGHT_FILES, installedBaseBundle } from './readiness'

export function comfyWeightsFolder(settings: Settings, bundleId: string): string {
  return join(paths.models(settings.modelsRoot), 'training-weights', bundleId)
}

async function singleFile(id: string, settings: Settings): Promise<string> {
  const { model, record, root } = await componentSnapshot(id, settings)
  const weights = record.entries.filter((file) => file.path.endsWith('.safetensors'))
  if (weights.length !== 1) throw codedError('E_TRAINING_WEIGHTS', `「${model.name}」的文件不完整。请在模型库修复它。`)
  return safePath(root, weights[0]!.path)
}

/** Links (never copies) the base parts into place, replacing a link that no longer matches its source. */
export async function localWeightsFolder(settings: Settings): Promise<{ bundleId: string; path: string }> {
  const bundle = await installedBaseBundle(settings)
  if (!bundle) throw codedError('E_TRAINING_WEIGHTS', '还没有 MOSS-Image Base 模型。先在训练页点「准备」。')
  if (bundle.id !== 'moss-base-int8') return { bundleId: bundle.id, path: await prepareModelBundle(bundleBinding(bundle), settings) }
  const folder = comfyWeightsFolder(settings, bundle.id)
  const parts = [
    [bundle.components.dit, COMFY_WEIGHT_FILES.dit],
    [bundle.components.textEncoder, COMFY_WEIGHT_FILES.textEncoder],
    [bundle.components.vae, COMFY_WEIGHT_FILES.vae],
  ] as const
  for (const [id, relative] of parts) {
    const source = await singleFile(id, settings)
    const target = join(folder, relative)
    const size = await fileSize(source)
    if ((await fileSize(target)) === size && size >= 0) continue
    await rm(target, { force: true })
    await linkInPlace(source, target)
  }
  return { bundleId: bundle.id, path: folder }
}
