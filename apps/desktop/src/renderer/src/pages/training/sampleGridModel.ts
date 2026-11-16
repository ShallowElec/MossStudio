import type { TrainingSamples } from '@shared/training'
import { eta, thousands } from '../../lib/format'

/** One column of the sample grid: a step, with a picture per sample description or none yet. */
export interface SampleColumn {
  step: number
  label: string
  /** One per prompt, in prompt order; null where the trainer drew nothing. */
  images: Array<string | null>
  /** Not drawn yet: the run has still to reach this step. */
  pending: boolean
  /** Shown in a pending cell: how long until it is drawn. */
  pendingText: string
  /** Has a checkpoint, so it can be saved as the LoRA. */
  choosable: boolean
  chosen: boolean
}

/** "训练前" for the untrained base, "1,250 步" for a column header. */
export function columnLabel(step: number): string {
  return step === 0 ? '训练前' : `${thousands(step)} 步`
}

/** "第 2,500 步", as in 用 第 2,500 步 的结果. */
export function stepName(step: number): string {
  return step === 0 ? '训练前' : `第 ${thousands(step)} 步`
}

export interface SampleGridInput {
  samples: TrainingSamples
  chosenStep: number | null
  /** Steps between samples; 0 = samples are off. */
  sampleEvery: number
  totalSteps: number
  /** While running: the step reached and the time left for the rest, to place and time pending columns. */
  running?: { step: number; etaMs: number | null }
}

/**
 * The sample grid's columns, left to right: what the trainer drew (step 0
 * first), checkpoints without samples (they can still be chosen), and while
 * running, the steps still to come as empty columns with their time left.
 */
export function sampleColumns(input: SampleGridInput): SampleColumn[] {
  const { samples, chosenStep, sampleEvery, totalSteps, running } = input
  const prompts = samples.prompts.length
  const checkpoints = new Set(samples.checkpoints)
  const byStep = new Map<number, Array<string | null>>()
  for (const column of samples.columns) {
    byStep.set(
      column.step,
      Array.from({ length: prompts }, (_, index) => column.images[index] ?? null),
    )
  }
  for (const step of checkpoints)
    if (!byStep.has(step))
      byStep.set(
        step,
        Array.from({ length: prompts }, () => null),
      )
  const drawn: SampleColumn[] = [...byStep.entries()]
    .sort(([a], [b]) => a - b)
    .map(([step, images]) => ({
      step,
      label: columnLabel(step),
      images,
      pending: false,
      pendingText: '',
      choosable: step > 0 && checkpoints.has(step),
      chosen: chosenStep === step,
    }))
  if (!running || sampleEvery <= 0) return drawn

  const reached = Math.max(running.step, drawn.at(-1)?.step ?? 0)
  const left = Math.max(1, totalSteps - running.step)
  const msPerStep = running.etaMs && running.etaMs > 0 ? running.etaMs / left : null
  const pending: SampleColumn[] = []
  const first = samples.nextStep ?? (Math.floor(reached / sampleEvery) + 1) * sampleEvery
  for (let step = first; step <= totalSteps; step += sampleEvery) {
    if (byStep.has(step)) continue
    pending.push({
      step,
      label: columnLabel(step),
      images: Array.from({ length: prompts }, () => null),
      pending: true,
      pendingText: msPerStep ? eta((step - running.step) * msPerStep) : '',
      choosable: false,
      chosen: false,
    })
  }
  return [...drawn, ...pending]
}

/** The newest column that has pictures, to keep in view while a run goes on. */
export function newestDrawnStep(columns: readonly SampleColumn[]): number | null {
  return [...columns].reverse().find((column) => !column.pending && column.images.some(Boolean))?.step ?? null
}
