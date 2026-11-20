import { bundleGpusProblem } from '@shared/bundleFit'
import { localDitNeeds } from '@shared/localBundle'
import { importProblemText } from '@shared/modelImport'
import type { DownloadTask, ModelBundle, ModelEntry, ModelImportFile, ModelImportState } from '@shared/types'
import { bundleBlocker, bundleProgress, bundleView, modelSourceKindLabels, sizeText, type ModelPlace, type ProgressInfo } from './logic'

/**
 * What the 导入模型 sheet shows: one row per file (a spinner while the engine
 * checks it, then what it is), and the whole models the files made. Pure, so
 * every case is unit tested; the wording of a refusal is `importProblemText`.
 */

export interface ImportRowView {
  path: string
  name: string
  /** Still being checked, or waiting for an engine. */
  busy: boolean
  /** What it is: 模型, 模型的一部分, LoRA, 控制适配器, 模型目录; null while checking or when unusable. */
  tag: string | null
  unusable: boolean
  /** The line under the name: what was recognised, or why it cannot be used. */
  line: string | null
  offer?: { bundleId: string; label: string }
}

const KIND_TAG = { model: '模型', part: '模型的一部分', lora: 'LoRA', control: '控制适配器', source: '模型目录' } as const

/**
 * The verdict on one file. A part the engine loads can still not run here: an
 * NVFP4 main model needs the GPU its catalog bundle names, and a computer
 * running only 兼容模式 reads no single file.
 */
export function importRow(file: ModelImportFile, place: ModelPlace): ImportRowView {
  const base = { path: file.path, name: file.name }
  if (file.state !== 'done' || !file.kind) return { ...base, busy: true, tag: null, unusable: false, line: null }
  const unusable = (line: string, offer?: ImportRowView['offer']): ImportRowView => ({
    ...base,
    busy: false,
    tag: null,
    unusable: true,
    line,
    ...(offer ? { offer } : {}),
  })
  if (file.kind === 'unusable') return unusable(importProblemText(file.problem ?? 'not-moss', file.path), file.offer)
  if (file.kind === 'part' || file.kind === 'model') {
    const allCli = place.gpus.length > 0 && place.gpus.every((gpu) => place.cliGpus?.has(gpu.uuid))
    if (allCli && file.role !== 'full') return unusable(importProblemText('cli', file.path))
    if (file.role === 'dit' && file.precision) {
      const needs = localDitNeeds({ name: file.name, precision: file.precision })
      if (needs.requires && bundleGpusProblem(needs, place.gpus, { cliGpus: place.cliGpus, files: true })) {
        return unusable(importProblemText('nvfp4', file.path, needs.requires.label))
      }
    }
  }
  const line =
    file.kind === 'lora' || file.kind === 'control'
      ? '已加入'
      : file.kind === 'source'
        ? `已接入 ${file.app ? modelSourceKindLabels[file.app] : '模型目录'}`
        : file.catalogName
          ? `认出来了：${file.catalogName}`
          : file.converts
            ? '第一次使用时要先转换，会多花一点时间'
            : null
  return { ...base, busy: false, tag: KIND_TAG[file.kind], unusable: false, line }
}

const PART_NAME: Record<ModelEntry['role'], string> = {
  dit: '主模型',
  text_encoder: '文本编码器',
  vae: 'VAE',
  full: '模型',
  support: '运行配置',
}

/** 文本编码器和 VAE: joined with 和, a space before a Latin word as the rest of the UI writes it. */
function spaced(names: readonly string[]): string {
  return names.reduce((text, name, index) => `${text}${index ? '和' : ''}${/^[A-Za-z]/.test(name) ? ' ' : ''}${name}`, '')
}

export interface ImportModelView {
  bundle: ModelBundle
  /** `ready`: 可以用了; `needs`: parts to download (`action`); `busy`: downloading; `blocked`: cannot run here. */
  status: 'ready' | 'needs' | 'busy' | 'blocked'
  /** 「还缺文本编码器和 VAE · 下载 9.8 GB」: the runtime config comes along without being named. */
  action: string | null
  /** Why it cannot run here, or what keeps it from being ready (a moved file). */
  reason: string | null
  progress: ProgressInfo | null
}

/** The whole models of an import, as they are now: downloads and the GPU decide whether 可以用了. */
export function importModels(
  state: ModelImportState,
  catalog: { bundles: readonly ModelBundle[]; models: readonly ModelEntry[] },
  tasks: readonly DownloadTask[],
  place: ModelPlace,
): ImportModelView[] {
  const views: ImportModelView[] = []
  for (const { bundleId } of state.models) {
    const bundle = catalog.bundles.find((item) => item.id === bundleId)
    if (!bundle) continue
    const view = bundleView(bundle, catalog.models, tasks, undefined, bundleBlocker(bundle, catalog.models, place))
    const progress = bundleProgress(view)
    if (view.blocked) views.push({ bundle, status: 'blocked', action: null, reason: view.blocked, progress })
    else if (view.status === 'ready') views.push({ bundle, status: 'ready', action: null, reason: null, progress: null })
    else if (progress) views.push({ bundle, status: 'busy', action: null, reason: null, progress })
    else if (view.status === 'lost') views.push({ bundle, status: 'blocked', action: null, reason: view.stateText, progress: null })
    else {
      const named = [...new Set(view.missing.filter((model) => model.role !== 'support').map((model) => PART_NAME[model.role]))]
      views.push({
        bundle,
        status: 'needs',
        action: `还缺${spaced(named.length ? named : [PART_NAME.support])} · 下载 ${sizeText(view.downloadBytes)}`,
        reason: null,
        progress: null,
      })
    }
  }
  return views
}

/** The sheet's title: how many files are being checked, then the model that can be used. */
export function importTitle(state: ModelImportState | null, models: readonly ImportModelView[]): string {
  if (!state) return '导入模型'
  if (state.phase === 'waiting-engine') return `${state.files.length} 个文件等引擎来识别`
  if (state.phase !== 'done') return `正在识别 ${state.files.length} 个文件…`
  const ready = models.filter((model) => model.status === 'ready')
  return ready.length === 1 ? `可以用了：${ready[0]!.bundle.name}` : '识别完了'
}

/** Files checked so far, for the bar: N of M. */
export function importProgress(state: ModelImportState): { done: number; total: number; percent: number } {
  const total = state.files.length
  const done = state.files.filter((file) => file.state === 'done').length
  return { done, total, percent: total ? Math.floor((done / total) * 100) : 0 }
}
