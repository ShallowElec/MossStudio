import type { TrainingProject } from '@shared/training'
import type { JobRecord } from '@shared/types'
import { eta, thousands } from '../../lib/format'

export interface RunProgress {
  step: number
  total: number
  /** 0–100; null before the trainer reports a step (the bar moves instead). */
  percent: number | null
  etaMs: number | null
  /** "1,250 / 3,000 步 · 还要约 24 分钟", or what the run is doing before its first step. */
  text: string
  loss: number | null
}

/** Where a running training is, from its job (metrics, progress, time left) and the training itself. */
export function runProgress(training: Pick<TrainingProject, 'recipe' | 'stepReached'>, job: JobRecord | undefined): RunProgress {
  const total = job && job.progress.total > 0 ? job.progress.total : training.recipe.steps
  const step = Math.max(job?.metrics?.step ?? job?.progress.current ?? 0, training.stepReached)
  const loss = typeof job?.metrics?.loss === 'number' && Number.isFinite(job.metrics.loss) ? job.metrics.loss : null
  const etaMs = job?.progress.etaMs && job.progress.etaMs > 0 ? job.progress.etaMs : null
  if (!job || job.state === 'queued' || job.state === 'starting' || step <= 0) {
    const doing = job?.state === 'queued' ? '排队中' : '正在启动…'
    return { step: 0, total, percent: null, etaMs, text: doing, loss }
  }
  const left = etaMs ? eta(etaMs) : ''
  const text = `${thousands(step)} / ${thousands(total)} 步${left ? ` · 还要${left}` : ''}`
  return { step, total, percent: Math.max(0, Math.min(100, (step / total) * 100)), etaMs, text, loss }
}

/** Loss values seen per job this session, for the curve; the trainer reports only the newest. */
const seen = new Map<string, Array<{ step: number; loss: number }>>()

/** Add the job's newest loss to its curve (once per step) and return the curve. */
export function lossCurve(job: JobRecord | undefined): Array<{ step: number; loss: number }> {
  if (!job) return []
  const points = seen.get(job.id) ?? []
  const step = job.metrics?.step
  const loss = job.metrics?.loss
  if (typeof step === 'number' && typeof loss === 'number' && Number.isFinite(loss) && step > (points.at(-1)?.step ?? -1)) {
    points.push({ step, loss })
    seen.set(job.id, points.slice(-400))
  }
  return seen.get(job.id) ?? points
}

/** The curve as an SVG path in a width × height box (loss rises upward). */
export function curvePath(points: ReadonlyArray<{ step: number; loss: number }>, width: number, height: number): string {
  if (points.length < 2) return ''
  const steps = points.map((point) => point.step)
  const losses = points.map((point) => point.loss)
  const [minStep, maxStep] = [Math.min(...steps), Math.max(...steps)]
  const [minLoss, maxLoss] = [Math.min(...losses), Math.max(...losses)]
  const x = (step: number): number => (maxStep === minStep ? 0 : ((step - minStep) / (maxStep - minStep)) * width)
  const y = (loss: number): number => (maxLoss === minLoss ? height / 2 : height - ((loss - minLoss) / (maxLoss - minLoss)) * height)
  return points.map((point, index) => `${index ? 'L' : 'M'}${x(point.step).toFixed(1)} ${y(point.loss).toFixed(1)}`).join(' ')
}
