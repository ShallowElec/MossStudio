import { RUNTIME_CONFIG_ID } from './bundleFit'
import type { ModelBundle, ModelEntry } from './types'

/**
 * A bundle made of files the user already has on disk.
 *
 * A scanned ComfyUI tree registers single-file components in place; when a DiT,
 * a text encoder and a VAE are all available the Models page offers them as one
 * bundle. The engine receives the three files as `dit_file` /
 * `text_encoder_file` / `vae_file`, so nothing is copied, linked or re-downloaded;
 * it still needs the configs and tokenizer of the small runtime-config download.
 */
export function localFilesBundle(models: readonly ModelEntry[]): ModelBundle | null {
  const pick = (role: ModelEntry['role']): ModelEntry | undefined =>
    models.find((model) => model.provider === 'local' && model.role === role && model.installed)
  const dit = pick('dit')
  const textEncoder = pick('text_encoder')
  const vae = pick('vae')
  if (!dit || !textEncoder || !vae) return null
  return {
    id: 'local-files',
    name: '本地文件（扫描）',
    description: '直接使用你添加到模型库的本地文件，不复制、不下载。',
    components: { dit: dit.id, textEncoder: textEncoder.id, vae: vae.id },
    support: RUNTIME_CONFIG_ID,
    recommended: false,
    ...localDitNeeds(dit),
  }
}

const RTX_50 = { computeCapability: { major: 12, minor: 0 }, label: 'RTX 50 系列显卡' }

const TIERS = ['high', 'turbo'] as const

/**
 * The tier (and GPU) an own DiT needs. From what the engine's `inspect` said:
 * the one tier it accepts, else its precision (INT4 and NVFP4 run under turbo,
 * NVFP4 only on an RTX 50, INT8 under high); a bf16 file keeps the tier from 设置.
 * A file registered before the engine was asked has only its own file name to
 * go by, never the folders above it.
 */
export function localDitNeeds(
  dit: Pick<ModelEntry, 'name' | 'precision' | 'localPath' | 'files' | 'tiers'>,
): Pick<ModelBundle, 'tier' | 'requires'> {
  const precision = dit.precision && dit.precision !== 'local' ? dit.precision : null
  if (precision || dit.tiers?.length) {
    const requires = precision === 'nvfp4' ? { requires: RTX_50 } : {}
    const only = dit.tiers?.length === 1 ? TIERS.find((tier) => tier === dit.tiers![0]) : undefined
    if (only) return { tier: only, ...requires }
    if (precision === 'nvfp4' || precision === 'int4') return { tier: 'turbo', ...requires }
    if (precision === 'int8') return { tier: 'high' }
    return {}
  }
  const names = [dit.name, dit.localPath, ...(dit.files ?? [])]
    .filter((item): item is string => Boolean(item))
    .map((item) => item.split(/[\\/]/).pop()!)
    .join(' ')
    .toLowerCase()
  if (/nvfp4/.test(names)) return { tier: 'turbo', requires: RTX_50 }
  if (/int4/.test(names)) return { tier: 'turbo' }
  if (/int8|\.gguf\b/.test(names)) return { tier: 'high' }
  return {}
}
