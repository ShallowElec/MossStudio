import { adapterStatuses } from '@shared/adapters'
import type { BackendInfo } from '@shared/backend'
import { layoutById, orientedRects, panelGenerationSize } from '@shared/manga/layouts'
import type { MangaChapter, MangaPage, MangaPanel, MangaSeries } from '@shared/manga/model'
import { compilePanelPrompt } from '@shared/manga/prompt'
import type { Catalog, EngineFeatures, JobRecord } from '@shared/types'
import { profileFor, randomSeed } from '../studio/defaults'
import { resolveBundle } from '../studio/readiness'

/**
 * One panel as an engine job: the same request the Studio posts to the local
 * backend's /api/engine-jobs, built from the series instead of a canvas. A
 * problem comes back as a message and whether trying again could help (the
 * engine still starting can; a missing model cannot).
 */

export type PanelRequest = { ok: true; body: Record<string, unknown>; notes: string[] } | { ok: false; message: string; retry: boolean }

export function panelRequest(input: {
  series: MangaSeries
  chapter: MangaChapter
  page: MangaPage
  panel: MangaPanel
  catalog: Pick<Catalog, 'bundles' | 'models' | 'adapters'> | null
  preferredBundleId: string | null
  /** What the local engine can do; null when it could not be read (then nothing is dropped). */
  features: EngineFeatures | null
  random?: () => number
}): PanelRequest {
  const { series, chapter, page, panel, catalog, features } = input
  // Read at start-up; until it arrives nothing can be judged missing.
  if (!catalog) return { ok: false, message: '正在读取模型库…', retry: true }
  const compiled = compilePanelPrompt(series, panel)
  if (compiled.problems.length) return { ok: false, message: compiled.problems[0]!, retry: false }

  const choice = resolveBundle(catalog, series.style.modelBundleId, input.preferredBundleId)
  if (!choice.bundle) {
    const message = choice.unavailable ? '这部漫画用的模型已经不在模型库里，请在「设定」里换一个' : '还没有可用的模型，请先到模型页下载'
    return { ok: false, message, retry: false }
  }
  if (!choice.installed) return { ok: false, message: `「${choice.bundle.name}」还没有下载完`, retry: false }

  const missing = adapterStatuses(compiled.adapters, catalog?.adapters).filter((item) => !item.installed)
  if (missing.length) {
    return {
      ok: false,
      message: `LoRA ${missing.map((item) => `「${item.name}」`).join('')}找不到了，请移除或到模型库重新安装`,
      retry: false,
    }
  }
  const notes: string[] = []
  let adapters = compiled.adapters
  if (adapters.length && features && !features.lora) {
    notes.push('当前引擎不支持 LoRA，这一格没有用人物和画风的 LoRA')
    adapters = []
  }
  // Character pictures go into the prompt through the text encoder's vision tower (vision_references). The engine's
  // other `references` belong to an edit adapter and do nothing without one, so they are never sent from here.
  let references = compiled.references
  if (references.length && !features?.visionReferences) {
    notes.push('当前引擎还不支持人物参考图，这一格只用了文字描述和 LoRA')
    references = []
  }

  const layout = layoutById(page.layoutId)
  const index = page.panels.findIndex((item) => item.id === panel.id)
  const rect = layout ? orientedRects(layout, series.readingDirection)[index] : undefined
  const size = rect ? panelGenerationSize(rect) : { width: 1024, height: 1024 }
  const pageNumber = chapter.pages.findIndex((item) => item.id === page.id) + 1
  // The series' 质量 decides; a model's own steps and CFG (few-step models) are put into it when the model is chosen.
  const steps = series.style.steps
  const cfg = series.style.cfg

  return {
    ok: true,
    notes,
    body: {
      projectId: series.projectId,
      canvasId: panel.id,
      canvasTitle: `${series.title} 第 ${chapter.number} 话 第 ${pageNumber} 页 第 ${index + 1} 格`,
      modelBinding: { bundleId: choice.bundle.id, ...choice.bundle.components },
      modelName: choice.bundle.name,
      prompt: compiled.prompt,
      negativePrompt: compiled.negative,
      adapters,
      ...(references.length ? { visionReferences: { paths: references, maxPixels: compiled.referencePixels } } : {}),
      width: size.width,
      height: size.height,
      steps,
      cfg,
      // Every attempt draws a new seed, so a retry is a different picture.
      seed: randomSeed(input.random),
      profile: profileFor(steps),
      mode: 'runner',
    },
  }
}

function isJob(value: unknown): value is JobRecord {
  return Boolean(value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string')
}

export async function postPanelJob(backend: BackendInfo | null, body: Record<string, unknown>): Promise<JobRecord> {
  if (!backend?.ready || !backend.url || !backend.token) throw new Error('生成服务还在启动，请稍等几秒再试')
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 60_000)
  try {
    const response = await fetch(`${backend.url}/api/engine-jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${backend.token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const answer: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const error = answer && typeof answer === 'object' && 'error' in answer ? (answer as { error: unknown }).error : null
      throw new Error(typeof error === 'string' ? error : `生成服务返回了错误（${response.status}）`)
    }
    if (!isJob(answer)) throw new Error('生成服务返回了无法识别的任务')
    return answer
  } finally {
    window.clearTimeout(timer)
  }
}
