import {
  type TRAINING_LENGTHS,
  defaultSamplePrompts,
  lengthOf,
  presetRecipe,
  triggerFrom,
  type DatasetImage,
  type TrainingDataset,
  type TrainingKind,
  type TrainingProject,
  type TrainingRecipe,
} from '@shared/training'
import { dimensions, thousands } from '../../lib/format'
import { ALGO_LABEL } from './trainingModel'

/** The fields of a draft the editor changes (the `trainingUpdate` patch). */
export type DraftPatch = Partial<Pick<TrainingProject, 'name' | 'kind' | 'trigger' | 'length' | 'recipe' | 'hostId' | 'versionId'>>

type Preset = (typeof TRAINING_LENGTHS)[number]

export const LENGTH_LABEL: Record<Preset, string> = { fast: '快速', standard: '标准', fine: '精细' }

/** The words beside 训练多久: the step count, and 自定义 once a knob under 高级 was changed. */
export function lengthLabel(project: Pick<TrainingProject, 'length' | 'recipe'>): string {
  const steps = `${thousands(project.recipe.steps)} 步`
  return project.length === 'custom' ? `自定义 · ${steps}` : steps
}

/** 高级's one-line summary while it is closed: "LoKr · 3,000 步 · 本机". */
export function advancedSummary(project: Pick<TrainingProject, 'recipe'>, place: string): string {
  return [ALGO_LABEL[project.recipe.algo], `${thousands(project.recipe.steps)} 步`, place].filter(Boolean).join(' · ')
}

/** "LoKr · 4 · 1e-4 · 1024": the knobs that tell two runs apart, for the read-only summary. */
export function recipeLine(recipe: TrainingRecipe): string {
  return [ALGO_LABEL[recipe.algo], recipe.dim !== null ? String(recipe.dim) : '', recipe.lr ?? '', String(recipe.resolution)]
    .filter(Boolean)
    .join(' · ')
}

function fallbackTrigger(kind: TrainingKind): string {
  return kind === 'object' ? 'my_object' : 'my_person'
}

/**
 * 学什么 changed: the recipe follows the new kind at the same 训练多久 (a
 * custom one starts again from 标准), 画风 needs no trigger word, and the
 * sample descriptions are the new kind's. Pictures are not touched.
 */
export function withKind(project: TrainingProject, kind: TrainingKind): DraftPatch {
  if (kind === project.kind) return {}
  const trigger = kind === 'style' ? '' : project.trigger.trim() || triggerFrom(project.name, fallbackTrigger(kind))
  const length: Preset = project.length === 'custom' ? 'standard' : project.length
  const recipe = presetRecipe(kind, length, { samples: project.recipe.sampleEvery > 0, trigger })
  return { kind, trigger, length, recipe: { ...recipe, sampleEvery: project.recipe.sampleEvery } }
}

/** 训练多久 changed: that preset's recipe, keeping the person's sample settings. */
export function withLength(project: TrainingProject, length: Preset): DraftPatch {
  const preset = presetRecipe(project.kind, length, { samples: project.recipe.sampleEvery > 0, trigger: project.trigger })
  return {
    length,
    recipe: { ...preset, sampleEvery: project.recipe.sampleEvery, samplePrompts: project.recipe.samplePrompts },
  }
}

/** A knob under 高级 changed; 训练多久 reads 自定义 unless it still matches a preset. */
export function withRecipe(project: TrainingProject, patch: Partial<TrainingRecipe>): DraftPatch {
  const recipe = { ...project.recipe, ...patch }
  return { recipe, length: lengthOf(project.kind, recipe, project.trigger) }
}

/**
 * The trigger word changed. Sample descriptions follow it only while they are
 * still this kind's defaults (where the trigger stands as a word of its own);
 * descriptions the person wrote are theirs and stay as written.
 */
export function withTrigger(project: TrainingProject, trigger: string): DraftPatch {
  const prompts = project.recipe.samplePrompts
  const defaults = defaultSamplePrompts(project.kind, project.trigger)
  const untouched = prompts.length === defaults.length && prompts.every((prompt, index) => prompt === defaults[index])
  return untouched ? { trigger, recipe: { ...project.recipe, samplePrompts: defaultSamplePrompts(project.kind, trigger) } } : { trigger }
}

export type PictureFilter = 'all' | 'small' | 'duplicate' | 'noCaption'

/** The problem chips above the pictures, only for problems there are. */
export function problemChips(
  dataset: TrainingDataset,
): Array<{ filter: Exclude<PictureFilter, 'all'>; label: string; tone: 'warn' | 'neutral' }> {
  const { small, duplicate, noCaption } = dataset.counts
  return [
    small ? { filter: 'small' as const, label: `${small} 张太小`, tone: 'warn' as const } : null,
    duplicate ? { filter: 'duplicate' as const, label: `${duplicate} 张重复`, tone: 'warn' as const } : null,
    noCaption ? { filter: 'noCaption' as const, label: `${noCaption} 张没有描述`, tone: 'neutral' as const } : null,
  ].filter((chip) => chip !== null)
}

export function filterPictures(images: readonly DatasetImage[], filter: PictureFilter): DatasetImage[] {
  if (filter === 'small') return images.filter((image) => image.problems.includes('small'))
  if (filter === 'duplicate') return images.filter((image) => image.problems.includes('duplicate'))
  if (filter === 'noCaption') return images.filter((image) => image.caption === null || !image.caption.trim())
  return [...images]
}

/** The badge on a picture with a problem: "太小 · 384 × 288", "和第 3 张重复". */
export function problemBadge(image: DatasetImage): string | null {
  if (image.problems.includes('small')) return `太小 · ${dimensions(image.width, image.height)}`
  if (image.problems.includes('duplicate')) return image.duplicateOf ? `和第 ${image.duplicateOf} 张重复` : '重复'
  return null
}

/** The short form of a problem, for the list view's pill. */
export function problemPill(image: DatasetImage): string | null {
  if (image.problems.includes('small')) return '太小'
  if (image.problems.includes('duplicate')) return image.duplicateOf ? `和第 ${image.duplicateOf} 张重复` : '重复'
  return null
}

/** The dataset with one picture's new description in place, its 没有描述 count kept true. */
export function withImage(dataset: TrainingDataset, image: DatasetImage): TrainingDataset {
  const images = dataset.images.map((item) => (item.name === image.name ? image : item))
  const noCaption = images.filter((item) => item.caption === null || !item.caption.trim()).length
  return { images, counts: { ...dataset.counts, noCaption } }
}
