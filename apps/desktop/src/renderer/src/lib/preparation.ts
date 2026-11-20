import type { DownloadTask, MossInferDownloadState } from '@shared/types'
import { engineDownloadActive } from './engineInstall'
import { bytes } from './format'

/** One thing being prepared: the runtime (engine packages) or the model files. */
export interface PreparationPart {
  id: 'engine' | 'model'
  done: number
  total: number
  speedBps: number
  finished: boolean
  /** Some of it failed (other files of the model may still be downloading). */
  failed: boolean
  /** Still downloading or installing, also next to a failed file. */
  active: boolean
  /** A download was paused: stopped on purpose, not a failure. */
  paused: boolean
}

/** Everything being prepared, as one number to watch. */
export interface Preparation {
  done: number
  total: number
  /** 0–100. */
  percent: number
  speedBps: number
  /** Null until there is a speed to go by. */
  secondsLeft: number | null
  /** Still downloading or installing. */
  active: boolean
  /** A part, or a file of it, stopped with an error. */
  failed: boolean
  /** A download was paused. */
  paused: boolean
  parts: PreparationPart[]
}

const ACTIVE_TASK = new Set(['queued', 'running', 'verifying'])

function enginePart(download: MossInferDownloadState | null | undefined): PreparationPart | null {
  if (!download || download.phase === 'canceled') return null
  const active = engineDownloadActive(download)
  // Several packages download one after another; their sizes are not known up front, so each counts as the current one.
  const count = download.step?.count ?? 1
  const index = download.step?.index ?? 0
  const each = download.totalBytes
  const total = each * count
  // Past the download (verifying, unpacking) the current package counts as fetched; a failed one counts what arrived.
  const current = download.phase === 'downloading' || download.phase === 'error' ? download.bytes : each
  const done = download.phase === 'done' ? total : Math.min(total, each * index + current)
  if (total <= 0 && !active) return null
  return {
    id: 'engine',
    done,
    total,
    speedBps: download.phase === 'downloading' ? download.speedBps : 0,
    finished: download.phase === 'done',
    failed: download.phase === 'error',
    active,
    paused: false,
  }
}

function modelPart(tasks: readonly DownloadTask[]): PreparationPart | null {
  if (tasks.length === 0) return null
  const total = tasks.reduce((sum, task) => sum + task.totalBytes, 0)
  const done = tasks.reduce((sum, task) => sum + (task.state === 'done' ? task.totalBytes : Math.min(task.bytes, task.totalBytes)), 0)
  const speedBps = tasks.reduce((sum, task) => sum + (task.state === 'running' ? task.speedBps : 0), 0)
  return {
    id: 'model',
    done,
    total,
    speedBps,
    finished: tasks.every((task) => task.state === 'done'),
    failed: tasks.some((task) => task.state === 'error'),
    active: tasks.some((task) => ACTIVE_TASK.has(task.state)),
    paused: tasks.some((task) => task.state === 'paused'),
  }
}

/**
 * The engine install and the model downloads as one progress: bytes done of
 * bytes to fetch, the combined speed and the time left. Null when nothing is
 * being prepared.
 */
export function preparationProgress(
  engineDownload: MossInferDownloadState | null | undefined,
  modelTasks: readonly DownloadTask[],
): Preparation | null {
  const parts = [enginePart(engineDownload), modelPart(modelTasks)].filter((part): part is PreparationPart => part !== null)
  const active = engineDownloadActive(engineDownload) || modelTasks.some((task) => ACTIVE_TASK.has(task.state))
  if (parts.length === 0) return null
  const done = parts.reduce((sum, part) => sum + part.done, 0)
  const total = parts.reduce((sum, part) => sum + part.total, 0)
  const speedBps = parts.reduce((sum, part) => sum + part.speedBps, 0)
  const percent = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0
  const left = Math.max(0, total - done)
  return {
    done,
    total,
    percent,
    speedBps,
    secondsLeft: active && speedBps > 0 ? left / speedBps : null,
    active,
    failed: parts.some((part) => part.failed),
    paused: parts.some((part) => part.paused),
    parts,
  }
}

/** Local model downloads (not those of a remote host). */
export function localModelTasks(downloads: readonly DownloadTask[]): DownloadTask[] {
  return downloads.filter((task) => task.kind === 'model' && !task.hostId)
}

/** "还要约 18 分钟", in plain words. */
export function timeLeftLabel(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null
  if (seconds < 60) return '不到 1 分钟'
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `约 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `约 ${hours} 小时 ${rest} 分钟` : `约 ${hours} 小时`
}

/** "1.2 GB / 25 GB"; 准备中 until the first bytes arrive, so it never reads 未知. */
export function preparationAmount(done: number, total: number): string {
  if (done <= 0 || total <= 0) return '准备中'
  return `${bytes(done)} / ${bytes(total)}`
}

/**
 * What the title bar chip says, or null when there is nothing to say. `text`
 * replaces the percentage and bar: when preparation stopped, or a part failed
 * while the other keeps going. A pause is not a failure.
 */
export function preparationChip(progress: Preparation): { warn: boolean; text: string | null; title: string } | null {
  if (!progress.active && !progress.failed && !progress.paused) return null
  if (!progress.active) return { warn: true, text: '准备没有完成', title: '准备没有完成，点开查看' }
  const failed = progress.parts.filter((part) => part.failed).length
  if (failed === 0) return { warn: false, text: null, title: '查看准备进度' }
  const failure = failed > 1 ? '有两项没下载完' : '有一项没下载完'
  return { warn: true, text: `准备中 ${Math.round(progress.percent)}% · ${failure}`, title: `${failure}，点开重试` }
}
