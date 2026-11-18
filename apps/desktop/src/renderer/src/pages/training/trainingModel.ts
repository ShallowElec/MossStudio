import type { DownloadTask, ModelBundle } from '@shared/types'
import type { TrainingAlgo, TrainingKind, TrainingProject, TrainingReadiness, TrainingState } from '@shared/training'
import { bytes, diskFree, memorySize, packageProgressText, percent, thousands } from '../../lib/format'

/** What the 训练 page shows at `/training`. */
export type HomeView = 'loading' | 'error' | 'blocked' | 'oobe' | 'start' | 'home'

/**
 * The 训练 page's first screen: a computer that cannot train says so; with no
 * trainings yet, an unprepared one shows what preparing will do (first use),
 * and a prepared one asks what to teach. Once there are trainings, they are
 * the page. `picking` (先选图片 while preparing, or 新建训练) asks what to teach.
 */
export function homeView(
  readiness: TrainingReadiness | null | undefined,
  trainings: readonly TrainingProject[] | undefined,
  options: { picking?: boolean } = {},
): HomeView {
  if (readiness === undefined || trainings === undefined) return 'loading'
  if (readiness?.blockReason) return 'blocked'
  if (options.picking) return 'start'
  if (trainings.length) return 'home'
  if (readiness === null) return 'error'
  return readiness.ready ? 'start' : 'oobe'
}

/** What `/training/:id` shows for a training in this state. */
export type ProjectView = 'editor' | 'running' | 'result'

export function projectView(state: TrainingState): ProjectView {
  if (state === 'draft') return 'editor'
  if (state === 'starting' || state === 'running') return 'running'
  return 'result'
}

export const KIND_LABEL: Record<TrainingKind, string> = { person: '人物', style: '画风', object: '物品' }

/** The Start tiles say a little more than the 学什么 switch. */
export const KIND_TILE_LABEL: Record<TrainingKind, string> = { person: '人物或角色', style: '画风', object: '物品' }

export const ALGO_LABEL: Record<TrainingAlgo, string> = { lora: 'LoRA', lokr: 'LoKr', loha: 'LoHa', dora: 'DoRA', oft: 'OFT' }

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'

/** One line of the first-use check: what it is, what this computer has, and whether that works. */
export interface CheckRow {
  id: 'gpu' | 'ram' | 'model' | 'trainer' | 'disk'
  title: string
  value: string
  pill: { tone: Tone; text: string }
  /** While preparing: 0–100, or null for a moving bar. Absent when nothing is happening on this row. */
  progress?: number | null
  /** Under the bar: amount and speed, when known. */
  detail?: string
}

const ACTIVE_DOWNLOAD = new Set<DownloadTask['state']>(['queued', 'running', 'verifying'])

/** The base model's local download tasks (its 主模型, 文本编码器 and VAE). */
export function baseModelTasks(bundle: ModelBundle | undefined, downloads: readonly DownloadTask[]): DownloadTask[] {
  if (!bundle) return []
  const ids = new Set(Object.values(bundle.components))
  return downloads.filter((task) => task.kind === 'model' && !task.hostId && ids.has(task.targetId))
}

/** The rows of the first-use check, with live progress while preparing. */
export function checkRows(readiness: TrainingReadiness, modelTasks: readonly DownloadTask[] = []): CheckRow[] {
  const preparing = readiness.prepare.running
  const gpuValue = [readiness.gpu.name, readiness.gpu.memoryBytes ? memorySize(readiness.gpu.memoryBytes) : ''].filter(Boolean).join(' · ')
  const rows: CheckRow[] = [
    {
      id: 'gpu',
      title: '显卡',
      value: gpuValue || '没有找到显卡',
      pill: readiness.gpu.ok ? { tone: 'ok', text: '可以训练' } : { tone: 'danger', text: '不能训练' },
    },
    {
      id: 'ram',
      title: '内存',
      value: readiness.ramBytes ? memorySize(readiness.ramBytes) : '未知',
      pill: readiness.ramLow ? { tone: 'warn', text: '有点少' } : { tone: 'ok', text: '够用' },
    },
    modelRow(readiness, modelTasks, preparing),
    trainerRow(readiness, preparing),
    {
      id: 'disk',
      title: '空间',
      value: [readiness.disk.path, readiness.disk.freeBytes !== null ? `剩余 ${diskFree(readiness.disk.freeBytes)}` : '']
        .filter(Boolean)
        .join(' · '),
      pill: readiness.disk.ok ? { tone: 'ok', text: '够用' } : { tone: 'danger', text: '空间不够' },
    },
  ]
  return rows
}

function modelRow(readiness: TrainingReadiness, tasks: readonly DownloadTask[], preparing: boolean): CheckRow {
  const base = { id: 'model' as const, title: '底模', value: readiness.baseModel.name }
  if (readiness.baseModel.installed) return { ...base, pill: { tone: 'ok', text: '已下载' } }
  const failed = tasks.find((task) => task.state === 'error' || task.state === 'paused')
  if (failed) return { ...base, pill: { tone: 'warn', text: failed.state === 'paused' ? '已暂停' : '下载没有完成' } }
  const active = tasks.filter((task) => ACTIVE_DOWNLOAD.has(task.state) || task.state === 'done')
  if (active.some((task) => ACTIVE_DOWNLOAD.has(task.state))) {
    const total = active.reduce((sum, task) => sum + task.totalBytes, 0)
    const done = active.reduce((sum, task) => sum + (task.state === 'done' ? task.totalBytes : Math.min(task.bytes, task.totalBytes)), 0)
    const speed = active.reduce((sum, task) => sum + (task.state === 'running' ? task.speedBps : 0), 0)
    const value = Math.round(percent(done, total))
    return {
      ...base,
      pill: { tone: 'accent', text: `下载中 ${value}%` },
      progress: total > 0 ? value : null,
      detail: [`${bytes(done)} / ${bytes(total)}`, speed > 0 ? `${bytes(speed)}/s` : ''].filter(Boolean).join(' · '),
    }
  }
  if (preparing) return { ...base, pill: { tone: 'accent', text: '等待下载' }, progress: null }
  return { ...base, pill: { tone: 'neutral', text: `需要下载 · ${bytes(readiness.baseModel.missingBytes)}` } }
}

const PREPARE_TRAINER_TEXT = { trainer: '正在下载训练器', environment: '正在安装训练环境' } as const

function trainerRow(readiness: TrainingReadiness, preparing: boolean): CheckRow {
  const state = readiness.trainer.state
  const step = readiness.prepare.step
  const base = { id: 'trainer' as const, title: '训练环境' }
  if (state === 'ready') return { ...base, value: 'Kohaku Trainer', pill: { tone: 'ok', text: '已准备' } }
  // Packages mean the environment is installing, even while `step` says the base model is downloading alongside.
  const packages = preparing ? readiness.prepare.packages : null
  if (state === 'installing' || packages || (preparing && (step === 'trainer' || step === 'environment'))) {
    const doing = packages
      ? PREPARE_TRAINER_TEXT.environment
      : step === 'trainer'
        ? PREPARE_TRAINER_TEXT.trainer
        : PREPARE_TRAINER_TEXT.environment
    // The percentage is known for one package at a time, and only from pip.
    return {
      ...base,
      value: `Kohaku Trainer · ${doing}`,
      pill: { tone: 'accent', text: '安装中' },
      progress: packages?.stage === 'download' ? (packages.percent ?? null) : null,
      ...(packages ? { detail: packageProgressText(packages) } : {}),
    }
  }
  if (preparing) return { ...base, value: 'Kohaku Trainer', pill: { tone: 'accent', text: '等待安装' }, progress: null }
  if (state === 'error') return { ...base, value: 'Kohaku Trainer', pill: { tone: 'danger', text: '安装失败' } }
  return { ...base, value: 'Kohaku Trainer', pill: { tone: 'neutral', text: '需要下载' } }
}

/** Why this computer cannot train, in one sentence under the title. */
export function blockedText(readiness: TrainingReadiness): string {
  if (readiness.blockReason === 'mac') return '训练需要 NVIDIA 显卡，Mac 上不能训练。'
  if (readiness.blockReason === 'low-vram') return '训练需要 6 GB 以上显存的 NVIDIA 显卡，这张显卡的显存不够。'
  return '训练需要 6 GB 以上显存的 NVIDIA 显卡。'
}

/** A card on the 训练 page. */
export interface HomeCard {
  id: string
  name: string
  kind: string
  cover: string | null
  /** A state worth a Pill; a finished training shows its kind instead. */
  pill: { tone: Tone; text: string } | null
  caption: string
}

const UNDER_WAY = new Set<TrainingState>(['starting', 'running'])

/** Trainings under way first (starting or running; they get the wide card), then the rest, newest first. */
export function splitHome(trainings: readonly TrainingProject[]): { running: TrainingProject[]; rest: TrainingProject[] } {
  const sorted = [...trainings].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return { running: sorted.filter((item) => UNDER_WAY.has(item.state)), rest: sorted.filter((item) => !UNDER_WAY.has(item.state)) }
}

export function homeCard(training: TrainingProject, relative: (value: string) => string): HomeCard {
  const base = { id: training.id, name: training.name, kind: KIND_LABEL[training.kind], cover: training.cover }
  if (training.state === 'failed') return { ...base, pill: { tone: 'danger', text: '失败' }, caption: training.failure ?? '训练没有完成' }
  if (training.state === 'stopped')
    return { ...base, pill: { tone: 'neutral', text: '已停止' }, caption: `停在第 ${thousands(training.stepReached)} 步` }
  if (training.state === 'draft')
    return {
      ...base,
      pill: { tone: 'neutral', text: '未开始' },
      caption: training.imageCount ? `${training.imageCount} 张图片` : '还没有图片',
    }
  if (training.saveError) return { ...base, pill: { tone: 'warn', text: '没有保存' }, caption: training.saveError }
  return { ...base, pill: null, caption: relative(training.finishedAt ?? training.updatedAt) }
}

/**
 * What the result view offers about the saved LoRA. It is usable whenever one
 * is in 模型 (a later failed save of another step does not take it away), and
 * 重试 saves the step whose save failed.
 */
export function savedLora(project: Pick<TrainingProject, 'adapterId' | 'chosenStep' | 'saveError' | 'saveErrorStep'>): {
  saved: boolean
  retryStep: number | null
} {
  return {
    saved: project.adapterId !== null,
    retryStep: project.saveError ? (project.saveErrorStep ?? project.chosenStep) : null,
  }
}
