/**
 * Training, as people see it: a 训练 is one LoRA in the making (its pictures, what it
 * learns and how long), its run, the sample pictures per step and the step that was kept.
 * Main and renderer share these shapes; the trainer's own knobs stay in `TrainingRecipe`.
 */
import { z } from 'zod'
import type { PackageInstallProgress } from './types'

export const TRAINING_KINDS = ['person', 'style', 'object'] as const
export type TrainingKind = (typeof TRAINING_KINDS)[number]

export const TRAINING_LENGTHS = ['fast', 'standard', 'fine'] as const
/** `custom` once someone changed a recipe knob under 高级. */
export type TrainingLength = (typeof TRAINING_LENGTHS)[number] | 'custom'

/** LyCORIS algorithms offered in the app. A full finetune is not a LoRA, so it is not offered. */
export const TRAINING_ALGOS = ['lora', 'lokr', 'loha', 'dora', 'oft'] as const
export type TrainingAlgo = (typeof TRAINING_ALGOS)[number]

/** `auto` lets the trainer read the card; a number forces that VRAM layer (`--vram`). */
export const TRAINING_VRAM = ['auto', '6', '8', '12', '16', '24'] as const
export type TrainingVram = (typeof TRAINING_VRAM)[number]

export interface TrainingRecipe {
  algo: TrainingAlgo
  /** null: the algorithm layer's own value (LoKr uses a factor, not a rank). */
  dim: number | null
  alpha: number | null
  lr: string | null
  steps: number
  batch: number
  /** Training area side in pixels; the trainer gets TARGET_AREA = resolution². */
  resolution: number
  vram: TrainingVram
  /** Steps between sample pictures and checkpoints; 0 turns samples off (checkpoints stay every 500). */
  sampleEvery: number
  samplePrompts: string[]
  /** `KEY=VALUE` lines passed as `--set`. */
  overrides: string
}

/** `starting`: pictures are being prepared or uploaded and the job is being started; nothing is editable. */
export type TrainingState = 'draft' | 'starting' | 'running' | 'done' | 'failed' | 'stopped'

export interface TrainingProject {
  id: string
  name: string
  kind: TrainingKind
  /** ASCII word that calls the subject up in a 描述. Empty for 画风. */
  trigger: string
  length: TrainingLength
  recipe: TrainingRecipe
  hostId: string
  /** Trainer version; null = the location's newest ready version at start. */
  versionId: string | null
  state: TrainingState
  createdAt: string
  updatedAt: string
  /** The current or last run. */
  jobId: string | null
  runName: string | null
  startedAt: string | null
  finishedAt: string | null
  /** Last step the run reached (from the job, or the newest checkpoint). */
  stepReached: number
  /** Step whose checkpoint is the saved LoRA; null until one is saved. */
  chosenStep: number | null
  adapterId: string | null
  /** Why the LoRA could not be saved, in plain words; the 完成 view offers 重试. */
  saveError: string | null
  /** The step whose save failed; 重试 saves this one. null when saveError is null. */
  saveErrorStep: number | null
  /** Why the run failed, in plain words. */
  failure: string | null
  /** A sample picture to show on the card: the chosen step's first sample, else the newest. */
  cover: string | null
  imageCount: number
}

export type DatasetProblem = 'small' | 'duplicate'

export interface DatasetImage {
  /** File name inside the training's own pictures folder. */
  name: string
  path: string
  width: number
  height: number
  /** null: no sidecar `.txt`. */
  caption: string | null
  problems: DatasetProblem[]
  /** For `duplicate`: the 1-based position of the first identical picture. */
  duplicateOf?: number
}

export interface TrainingDataset {
  images: DatasetImage[]
  counts: { total: number; small: number; duplicate: number; noCaption: number }
}

export interface TrainingSampleColumn {
  step: number
  /** One picture per sample prompt, in prompt order. */
  images: string[]
}

export interface TrainingSamples {
  prompts: string[]
  /** Step 0 (训练前) first when the trainer drew it. */
  columns: TrainingSampleColumn[]
  /** Steps that have a checkpoint, so they can be chosen even without samples. */
  checkpoints: number[]
  /** The next step that will get samples while running; null otherwise. */
  nextStep: number | null
}

export type TrainingBlockReason = 'mac' | 'no-nvidia' | 'low-vram'
export type TrainingPrepareStep = 'model' | 'trainer' | 'environment'

export interface TrainingReadiness {
  hostId: string
  gpu: { name: string; memoryBytes: number | null; ok: boolean }
  ramBytes: number | null
  /** Host RAM below what small VRAM layers need; a warning, not a block. */
  ramLow: boolean
  baseModel: { bundleId: string; name: string; installed: boolean; missingBytes: number }
  trainer: { versionId: string | null; state: 'missing' | 'installing' | 'ready' | 'error' }
  disk: { path: string; freeBytes: number | null; ok: boolean }
  blockReason: TrainingBlockReason | null
  ready: boolean
  prepare: {
    running: boolean
    step: TrainingPrepareStep | null
    error: string | null
    /** While the environment installs: the package download under way. */
    packages?: PackageInstallProgress | null
  }
  /** Whether samples default to on here (off on cards of 8 GB or less). */
  samplesByDefault: boolean
}

export const MIN_TRAINING_VRAM_BYTES = 6 * 1024 ** 3
export const SMALL_PICTURE_SIDE = 512
export const DEFAULT_CHECKPOINT_EVERY = 500

const STEPS: Record<TrainingKind, number> = { person: 3000, style: 1500, object: 2000 }
const LENGTH_FACTOR: Record<(typeof TRAINING_LENGTHS)[number], number> = { fast: 0.5, standard: 1, fine: 1.5 }

/**
 * Starting recipes per 学什么 (community recipes for MOSS-Image Base, to be tuned):
 * 人物 LoKr with the algorithm layer's factor, 画风 LoRA 32, 物品 LoRA 16.
 */
export function presetRecipe(
  kind: TrainingKind,
  length: (typeof TRAINING_LENGTHS)[number],
  options: { samples: boolean; trigger: string },
): TrainingRecipe {
  const steps = Math.round((STEPS[kind] * LENGTH_FACTOR[length]) / 250) * 250
  const base = {
    steps,
    batch: 1,
    resolution: 1024,
    vram: 'auto' as const,
    sampleEvery: options.samples ? 250 : 0,
    samplePrompts: defaultSamplePrompts(kind, options.trigger),
    overrides: '',
  }
  if (kind === 'person') return { ...base, algo: 'lokr', dim: null, alpha: null, lr: null }
  if (kind === 'style') return { ...base, algo: 'lora', dim: 32, alpha: 32, lr: '1e-4' }
  return { ...base, algo: 'lora', dim: 16, alpha: 16, lr: '1e-4' }
}

export function defaultSamplePrompts(kind: TrainingKind, trigger: string): string[] {
  const t = trigger.trim()
  if (kind === 'style') return ['一座海边小镇，清晨', '一只猫坐在窗台上', '城市街道，下雨的夜晚']
  if (kind === 'object') return [`${t}，放在木桌上，柔和的自然光`, `${t}，户外，阳光`, `${t} 的水彩画`]
  return [`${t}，坐在窗边，柔和的自然光`, `${t} 在雪地里`, `${t} 的水彩画`]
}

/** The recipe for a 训练多久 choice, or null when the recipe no longer matches any (自定义). */
export function lengthOf(kind: TrainingKind, recipe: TrainingRecipe, trigger: string): TrainingLength {
  for (const length of TRAINING_LENGTHS) {
    const preset = presetRecipe(kind, length, { samples: recipe.sampleEvery > 0, trigger })
    if (
      preset.algo === recipe.algo &&
      preset.dim === recipe.dim &&
      preset.alpha === recipe.alpha &&
      preset.lr === recipe.lr &&
      preset.steps === recipe.steps &&
      preset.batch === recipe.batch &&
      preset.resolution === recipe.resolution &&
      recipe.vram === 'auto' &&
      !recipe.overrides.trim()
    )
      return length
  }
  return 'custom'
}

/** A trigger word from a name: ASCII letters and digits only, else a short fallback. */
export function triggerFrom(name: string, fallback: string): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  return ascii.length >= 2 ? ascii.slice(0, 32) : fallback
}

const trigger = z
  .string()
  .trim()
  .max(32)
  .regex(/^[A-Za-z0-9_]*$/, '触发词只能用字母、数字和 _')

export const trainingRecipeSchema = z.object({
  algo: z.enum(TRAINING_ALGOS),
  dim: z.number().int().min(1).max(100_000).nullable(),
  alpha: z.number().min(0).max(100_000).nullable(),
  lr: z
    .string()
    .trim()
    .regex(/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i, '学习率需要是数字，例如 1e-4')
    .nullable(),
  steps: z.number().int().min(50).max(200_000),
  batch: z.number().int().min(1).max(64),
  resolution: z.number().int().min(256).max(2048),
  vram: z.enum(TRAINING_VRAM),
  sampleEvery: z.number().int().min(0).max(100_000),
  samplePrompts: z.array(z.string().trim().min(1).max(500)).min(1).max(6),
  overrides: z.string().max(8000),
})

export const trainingSchemas = {
  readiness: z.object({ hostId: z.string().min(1).max(120) }),
  prepare: z.object({ hostId: z.string().min(1).max(120) }),
  create: z.object({ kind: z.enum(TRAINING_KINDS), hostId: z.string().min(1).max(120).optional() }),
  id: z.object({ id: z.string().regex(/^tp-[a-z0-9-]{4,40}$/) }),
  update: z.object({
    id: z.string().regex(/^tp-[a-z0-9-]{4,40}$/),
    patch: z
      .object({
        name: z.string().trim().min(1).max(60),
        kind: z.enum(TRAINING_KINDS),
        trigger,
        length: z.enum([...TRAINING_LENGTHS, 'custom']),
        recipe: trainingRecipeSchema,
        hostId: z.string().min(1).max(120),
        versionId: z.string().min(1).max(120).nullable(),
      })
      .partial(),
  }),
  datasetAdd: z.object({ id: z.string().regex(/^tp-[a-z0-9-]{4,40}$/), paths: z.array(z.string().min(1).max(4096)).min(1).max(2000) }),
  datasetRemove: z.object({ id: z.string().regex(/^tp-[a-z0-9-]{4,40}$/), names: z.array(z.string().min(1).max(260)).min(1).max(2000) }),
  captionSet: z.object({ id: z.string().regex(/^tp-[a-z0-9-]{4,40}$/), name: z.string().min(1).max(260), caption: z.string().max(4000) }),
  captionAuto: z.object({
    id: z.string().regex(/^tp-[a-z0-9-]{4,40}$/),
    /** Only these pictures; default: every picture without a description. */
    names: z.array(z.string().min(1).max(260)).max(2000).optional(),
  }),
  chooseStep: z.object({ id: z.string().regex(/^tp-[a-z0-9-]{4,40}$/), step: z.number().int().min(0).max(1_000_000) }),
}

export interface TrainingCaptionResult {
  written: number
  failed: number
  /** Set when nothing could be written, e.g. no 语言模型 that can read pictures. */
  error: string | null
}
