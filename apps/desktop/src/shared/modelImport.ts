import { RUNTIME_CONFIG_ID } from './bundleFit'
import { isSharedModelId } from './sharedModels'
import type { ModelBundle, ModelEntry, ModelImportProblem } from './types'

/**
 * 导入模型: what the engine's `inspect` says a file is, which catalog part a file
 * is, and which parts make a whole model. Pure, shared by main (the import and
 * the shared model folders) and the renderer (the import sheet).
 *
 * `inspect` answers `kind`, `loadable`, `precision`, `quantization` and `note`
 * (MossInfer docs/server-protocol.md#inspect); a file the engine cannot use is
 * an answer with `loadable: false` or `kind: "unknown"` and the reason in `note`.
 */

/** Extensions the engine might read as weights; anything else is not a model file and is not sent to `inspect`. */
export const MODEL_FILE_EXTENSIONS = ['.safetensors', '.sft', '.gguf', '.ckpt', '.pt', '.pth', '.bin'] as const

export function isModelFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return MODEL_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/** A file name without its folder and extension: `sd_xl_base_1.0.safetensors` → `sd_xl_base_1.0`. */
export function fileStem(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path
  return name.replace(/\.(safetensors|sft|gguf|ckpt|pt|pth|bin)$/i, '')
}

export interface InspectReport {
  kind?: unknown
  loadable?: unknown
  precision?: unknown
  quantization?: unknown
  note?: unknown
  base_model?: unknown
  control_kinds?: unknown
}

export interface Recognition {
  /** The role the engine loads the file in; null when it cannot use it. */
  kind: 'dit' | 'text_encoder' | 'vae' | 'lora' | 'control_adapter' | null
  precision?: string
  /** A GGUF main model, converted by the engine the first time it loads. */
  converts?: boolean
  baseModel?: string
  controlKinds?: string[]
  problem?: ModelImportProblem
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The catalog spells INT4 ConvRot `int4`; the engine says `w4a4`. */
export function catalogPrecision(precision: string): string {
  return precision === 'w4a4' ? 'int4' : precision
}

/** What an `inspect` answer means for a person: the role it loads in, or why it cannot be used. */
export function recognize(report: InspectReport, fileName: string): Recognition {
  const kind = text(report.kind)
  const note = text(report.note)
  const gguf = /\.gguf$/i.test(fileName) || /^gguf/i.test(text(report.quantization))
  if (report.loadable === true && (kind === 'dit' || kind === 'text_encoder' || kind === 'vae')) {
    const precision = text(report.precision)
    return {
      kind,
      ...(precision ? { precision: catalogPrecision(precision) } : {}),
      ...(gguf && kind === 'dit' ? { converts: true } : {}),
    }
  }
  if (report.loadable === true && kind === 'lora') {
    const base = text(report.base_model)
    return { kind, ...(base ? { baseModel: base } : {}) }
  }
  if (report.loadable === true && kind === 'control_adapter') {
    const base = text(report.base_model)
    const kinds = Array.isArray(report.control_kinds)
      ? report.control_kinds.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
    return { kind, controlKinds: kinds, ...(base ? { baseModel: base } : {}) }
  }
  return { kind: null, problem: problemOf(kind, note, gguf) }
}

/** Why the engine refused a file, read from its kind and note. The note is the loader's own message. */
function problemOf(kind: string, note: string, gguf: boolean): ModelImportProblem {
  if (/pickle/i.test(note)) return 'format'
  if (/F8_E[45]M[23]|\bFP8\b|float8/i.test(note)) return 'fp8'
  if (/nvfp4/i.test(note)) return 'nvfp4'
  if (gguf) return 'gguf'
  // "BF16" never matches: there is no word boundary between B and F.
  if (/\bF16\b|\bFP16\b|float16/i.test(note)) return 'fp16'
  if (kind === 'lora' || kind === 'control_adapter') return 'lora-other'
  if (kind === 'dit' || kind === 'text_encoder' || kind === 'vae') return 'unsupported'
  return 'not-moss'
}

/**
 * One plain sentence about a file that cannot be used. `requiresLabel` names
 * the hardware a version needs, from the catalog's `requires` (e.g. RTX 50 系列显卡).
 */
export function importProblemText(problem: ModelImportProblem, path: string, requiresLabel = 'RTX 50 系列显卡'): string {
  const name = fileStem(path)
  switch (problem) {
    case 'not-model':
      return `${name} 不是模型文件。`
    case 'empty-folder':
      return '这个文件夹里没有模型文件。'
    case 'too-broad':
      return '请选择具体的模型文件夹，不要选整个磁盘或用户主目录。'
    case 'not-moss':
      return `${name} 不是 MOSS-Image 模型，MossStudio 用不了它。`
    case 'fp16':
      return '这是 FP16 版本，引擎读不了。换成 INT8 版本就能用。'
    case 'fp8':
      return '这是 FP8 版本，引擎读不了。可以改用 INT8 版本。'
    case 'nvfp4':
      return `这个版本只能在 ${requiresLabel}上用。`
    case 'gguf':
      return '这种压缩格式引擎读不了。'
    case 'format':
      return '这种文件格式引擎读不了。'
    case 'cli':
      return '这台电脑用兼容模式引擎，只能用完整的 BF16 模型文件夹。'
    case 'lora-other':
      return `${name} 不是给 MOSS-Image 用的，MossStudio 用不了它。`
    case 'unsupported':
      return '这个版本引擎读不了。'
    case 'folder-incomplete':
      return '这个模型文件夹不完整，缺少运行需要的文件。'
    case 'network':
      return '网络位置上的文件请用「选择文件…」导入。'
    case 'unreadable':
      return '读不到这个文件。'
    case 'check-failed':
      return '引擎没能检查这个文件，稍后再导入一次。'
  }
}

const baseName = (path: string): string => (path.split(/[\\/]/).pop() ?? path).toLowerCase()

/**
 * The catalog single file this file is: the same file name and exactly the same
 * size. No hash is read; the engine's `inspect` still has to agree on the role.
 */
export function catalogFileMatch(
  file: { name: string; sizeBytes: number },
  models: readonly ModelEntry[],
  role?: ModelEntry['role'],
): ModelEntry | undefined {
  const name = baseName(file.name)
  return models.find(
    (model) =>
      model.provider === 'hf' &&
      model.format === 'comfyui' &&
      model.files?.length === 1 &&
      baseName(model.files[0]!) === name &&
      model.sizeBytes === file.sizeBytes &&
      (!role || model.role === role),
  )
}

/** The catalog's certified single-file models (INT8, INT4, NVFP4…): they name which text encoder and VAE go with a main model. */
export function fileBundles(bundles: readonly ModelBundle[]): ModelBundle[] {
  return bundles.filter((bundle) => !bundle.custom && bundle.support === RUNTIME_CONFIG_ID)
}

/**
 * The single-file model whose text encoder and VAE suit a main model: the one
 * it is part of, else one with a main model of the same precision (INT8 DiT →
 * the INT8 set), the same flavour (Base or SFT) when the file name says, else
 * the one recommended for everyday use.
 */
export function matchingFileBundle(
  dit: { name: string; precision?: string; catalogId?: string },
  bundles: readonly ModelBundle[],
  models: readonly ModelEntry[],
): ModelBundle | undefined {
  const candidates = fileBundles(bundles)
  if (dit.catalogId) {
    const own = candidates.find((bundle) => bundle.components.dit === dit.catalogId)
    if (own) return own
  }
  const base = /base/i.test(dit.name)
  const turbo = /turbo/i.test(dit.name)
  const fits = (bundle: ModelBundle): boolean => /base/i.test(bundle.name) === base && /turbo/i.test(bundle.name) === turbo
  const same = candidates.filter((bundle) => models.find((model) => model.id === bundle.components.dit)?.precision === dit.precision)
  return (
    same.find(fits) ??
    same[0] ??
    candidates.find((bundle) => bundle.recommendedFor === 'limited-vram') ??
    candidates.find(fits) ??
    candidates[0]
  )
}

/** The INT8 single-file model to offer instead of a version the engine cannot read (FP16, FP8). */
export function int8Instead(fileName: string, bundles: readonly ModelBundle[], models: readonly ModelEntry[]): ModelBundle | undefined {
  return matchingFileBundle({ name: fileName, precision: 'int8' }, bundles, models)
}

/** A recognised main-model part of an import, under the id the catalog knows it by. */
export interface ImportedPart {
  id: string
  role: 'dit' | 'text_encoder' | 'vae'
  name: string
  precision?: string
  /** Set when the file is a catalog part (file name and size): `id` is then that part's id. */
  catalogId?: string
}

export type AssemblyStep =
  | { kind: 'bundle'; bundleId: string }
  | { kind: 'combination'; name: string; components: { dit: string; textEncoder: string; vae: string } }

export interface Assembly {
  steps: AssemblyStep[]
  /** More than one text encoder or VAE came with a main model: 自己组合 opens with these rather than a guess. */
  choose: { dit: string; textEncoder: string; vae: string } | null
}

/**
 * Whole models from the parts of one import. Each main model takes the text
 * encoder and VAE that came with it; a part that did not come is taken from the
 * matching single-file model and downloaded. When every part is a catalog part
 * of one certified model, that model is the result; otherwise a combination is
 * saved, named after the catalog model with （我的文件）, or after the file.
 */
export function assembleImport(parts: readonly ImportedPart[], bundles: readonly ModelBundle[], models: readonly ModelEntry[]): Assembly {
  const of = (role: ImportedPart['role']) => parts.filter((part) => part.role === role)
  const dits = of('dit')
  const encoders = of('text_encoder')
  const vaes = of('vae')
  if (!dits.length) return { steps: [], choose: null }
  if (encoders.length > 1 || vaes.length > 1) {
    const fallback = matchingFileBundle(dits[0]!, bundles, models)
    const textEncoder = encoders[0]?.id ?? fallback?.components.textEncoder
    const vae = vaes[0]?.id ?? fallback?.components.vae
    return { steps: [], choose: textEncoder && vae ? { dit: dits[0]!.id, textEncoder, vae } : null }
  }
  const steps: AssemblyStep[] = []
  for (const dit of dits) {
    const match = matchingFileBundle(dit, bundles, models)
    const textEncoder = encoders[0]?.id ?? match?.components.textEncoder
    const vae = vaes[0]?.id ?? match?.components.vae
    if (!textEncoder || !vae) continue
    const own = dit.catalogId ? fileBundles(bundles).find((bundle) => bundle.components.dit === dit.catalogId) : undefined
    if (own && own.components.textEncoder === textEncoder && own.components.vae === vae) {
      steps.push({ kind: 'bundle', bundleId: own.id })
      continue
    }
    steps.push({
      kind: 'combination',
      name: own ? `${own.name}（我的文件）` : fileStem(dit.name),
      components: { dit: dit.id, textEncoder, vae },
    })
  }
  return { steps, choose: null }
}

/** The person's own file: registered where it is, found in a shared folder, or standing in for a catalog part. */
export function isOwnFile(model: Pick<ModelEntry, 'provider' | 'tags'>): boolean {
  return model.provider === 'local' || model.tags.includes('local-file')
}

/** A part from a shared model folder whose file is gone: the scan drops its entry, so only the id is left. */
export function goneOwnPart(id: string, models: readonly Pick<ModelEntry, 'id'>[]): boolean {
  return isSharedModelId(id) && !models.some((model) => model.id === id)
}

/** The person's own file that is not where it was added (main says whether its disk or the file is missing). */
export function isLostOwnFile(model: Pick<ModelEntry, 'provider' | 'tags' | 'installed' | 'missingFile'>): boolean {
  return isOwnFile(model) && !model.installed && Boolean(model.missingFile)
}

/** The first own file of a model that is not where it was added: its name, where it was, and whether its disk is missing. */
export function lostFile(
  bundle: Pick<ModelBundle, 'components'>,
  models: readonly ModelEntry[],
): { name: string | null; path: string | null; place: 'drive' | 'file' } | null {
  for (const id of [bundle.components.dit, bundle.components.textEncoder, bundle.components.vae]) {
    const model = models.find((entry) => entry.id === id)
    if (model && isLostOwnFile(model)) {
      return { name: fileStem(model.localPath ?? model.name), path: model.localPath ?? null, place: model.missingFile ?? 'file' }
    }
    if (goneOwnPart(id, models)) return { name: null, path: null, place: 'file' }
  }
  return null
}

/** The Studio's blocker for a model whose own file moved: what is missing and the way out. */
export function lostFileText(bundleName: string, lost: NonNullable<ReturnType<typeof lostFile>>): string {
  const what = lost.name ? `「${lost.name}」${lost.path ? `（${lost.path}）` : ''}` : `「${bundleName}」用到的文件`
  return lost.place === 'drive' ? `找不到${what}。插上那块硬盘，或重新找到它。` : `找不到${what}。它被移动或删除了，重新找到它。`
}
