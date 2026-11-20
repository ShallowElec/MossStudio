import { useCallback, useRef } from 'react'
import type { BackendInfo } from '@shared/backend'
import type { Catalog, ControlAdapterEntry, EngineFeatures, JobRecord, ManagedHost, ModelBundle, ProjectCanvas } from '@shared/types'
import { Ipc } from '@shared/channels'
import { MAX_QUEUED_RUNS, blockedCanvasIds, canvasLineage } from '@shared/canvasJobBranch'
import { adapterStatuses, normalizeCanvasAdapters } from '@shared/adapters'
import { call } from '../../lib/api'
import { ACTIVE_JOB_STATES } from '../../lib/format'
import { electronStudioClient } from '../../lib/studioClient'
import { useApp } from '../../store'
import { smallerCanvas, taskCanvasFor } from './canvases'
import { profileFor, randomSeed, samplingForBundle, seedForRun } from './defaults'
import { resolveJobInputs } from './jobInputs'
import { compileCanvasPrompt } from './prompt'
import { resolveBundle } from './readiness'
import { generatedSnapshot, generationCanvas, nodeBlockers, styleLoraNote, withUpscaleSize } from './nodes'
import { queuedRunsOf, runsOf, shownRun, staleRunIds } from './runs'
import type { StudioProject } from './useStudioProject'

export type SeedMode = 'auto' | 'new' | 'same'

function isJobRecord(value: unknown): value is JobRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record['id'] === 'string' &&
    typeof record['state'] === 'string' &&
    ['queued', 'starting', 'running', 'succeeded', 'failed', 'canceled'].includes(record['state'])
  )
}

function errorMessage(body: unknown, status: number): string {
  const raw = body && typeof body === 'object' && 'error' in body ? (body as { error: unknown }).error : undefined
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object' && 'message' in raw && typeof (raw as { message: unknown }).message === 'string') {
    return (raw as { message: string }).message
  }
  return `生成服务返回了错误（${status}）`
}

/** How long the backend may take to accept a run before it counts as not sent. */
export const SUBMIT_TIMEOUT_MS = 60_000

/** A run taken at the click: its result card is on the board, waiting to be sent. */
interface PreparedRun {
  taskId: string
  /** The canvas as it was at the click (sized, seed and model settled). */
  source: ProjectCanvas
  /** What the engine gets: the description and LoRA with the 风格 nodes' added. */
  generating: ProjectCanvas
  /** The board at the click: inputs resolve against it. */
  canvases: ProjectCanvas[]
  bundle: ModelBundle
  prompt: string
  adapters: ReturnType<typeof normalizeCanvasAdapters>
  sampling: { steps: number; cfg: number }
  seed: number
  remoteHost: ManagedHost | null
  remoteModelPath?: string
}

type RunResult = { queued: boolean; canvasId?: string; jobId?: string; error?: string }

/**
 * Submitting runs. A click takes the canvas as it is right then: it checks it,
 * freezes its settings into a new result card (a waiting placeholder in the
 * 画面's filmstrip) and queues the send. Sends go one after another, so three
 * quick clicks make three runs, each with the settings of its own click; a
 * placeholder called off before its turn is never sent.
 */
export function useGenerate(options: {
  project: StudioProject
  catalog: Catalog | null
  preferredBundleId: string | null
  remoteHost: ManagedHost | null
  /** Registered control adapters (a canvas's control adapter id resolves to its file). */
  controlAdapters?: readonly ControlAdapterEntry[]
  controlAdaptersLoaded?: boolean
  notify: (message: string, tone: 'info' | 'success' | 'error') => void
}): {
  /** `smaller`: the 画面 goes one size step down first (it ran out of GPU memory). */
  generate: (canvasId?: string, seed?: SeedMode, runOptions?: { smaller?: boolean }) => Promise<RunResult>
} {
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const backend = useRef<BackendInfo | null>(null)
  const latest = useRef(options)
  latest.current = options

  const fail = useCallback((message: string): { queued: false; error: string } => {
    latest.current.notify(message, 'error')
    return { queued: false, error: message }
  }, [])

  /** Everything that does not wait: checks, seed, and the run's own card on the board. */
  const prepare = useCallback(
    (requestedId: string | null, seedMode: SeedMode, runOptions: { smaller?: boolean }): PreparedRun | { error: string } => {
      const { project, catalog, preferredBundleId, remoteHost } = latest.current
      let canvases = project.canvasesRef.current
      let found = canvases.find((canvas) => canvas.id === requestedId)
      if (!found) return { error: '先选中一个画面' }
      if (found.kind === 'style') return { error: '风格不能单独生成，把它接到画面上' }
      if (runOptions.smaller) {
        // The 画面 itself gets the smaller size, so the next run fits too and 尺寸 shows it.
        const smaller = smallerCanvas(found)
        if (!smaller) return { error: '已经是最小的尺寸了' }
        canvases = canvases.map((canvas) => (canvas.id === smaller.id ? smaller : canvas))
        found = smaller
      }
      // A 放大 is sized from its 原图; the run uses that size.
      const source = withUpscaleSize(found, canvases)
      const generating = generationCanvas(source, canvases)
      const jobs = useApp.getState().jobs
      if (blockedCanvasIds(canvases, jobs).has(source.id)) return { error: '这个画面或它的来源正在生成，等它完成后再试' }
      const runs = runsOf(source, canvases)
      if (queuedRunsOf(runs).length >= MAX_QUEUED_RUNS) return { error: '排队已满，等前面的画完再加' }

      const choice = resolveBundle(catalog, source.modelBundleId, preferredBundleId)
      if (!choice.bundle)
        return { error: choice.unavailable ? '这个画面用的模型已经不在模型库里，请换一个模型' : '还没有可用的模型，请先到模型页下载' }
      if (!choice.installed) return { error: `「${choice.bundle.name}」还没有下载完` }
      const remoteModelPath = remoteHost?.modelPath?.trim()
      if (remoteHost && !remoteModelPath) return { error: `「${remoteHost.name}」还没有设置模型位置，请到 设置 › 设备与引擎 填写` }
      const adapters = normalizeCanvasAdapters(generating.adapters)
      // A 风格's LoRA count too; the message says where they come from.
      const fromStyles = styleLoraNote(source, canvases)
      if (remoteHost && adapters.length) return { error: `在其他电脑上运行时暂不支持 LoRA，请移除 LoRA 或改回这台电脑${fromStyles}` }
      const missing = adapterStatuses(adapters, catalog?.adapters).filter((item) => !item.installed)
      if (missing.length)
        return { error: `LoRA ${missing.map((item) => `「${item.name}」`).join('')}找不到了，请移除或到模型库重新安装${fromStyles}` }
      // Regions are laid out on the first-pass size.
      const compiled = compileCanvasPrompt(generating.baseSize ? { ...generating, ...generating.baseSize } : generating)
      if (!compiled.ok) return { error: compiled.errors[0] ?? '描述还不完整' }
      const node = nodeBlockers(generating, canvases)
      if (node.length) return { error: node[0]!.message }

      // 'same' repeats the picture on this card: the seed its run used, not the
      // source's latest seed (a later 再来一张 from this card records a new one).
      // A 画面 repeats the run picked in its filmstrip.
      const shown = source.kind === 'layout' ? (shownRun(source, canvases)?.run ?? source) : source
      const shownSeed = jobs.find((job) => job.id === shown.jobId)?.params.seed ?? shown.outputs?.[0]?.seed ?? source.seed
      const seed = seedMode === 'same' ? shownSeed : seedMode === 'new' ? randomSeed() : seedForRun(source)
      // A canvas that never picked a model runs with the one it resolves to; a few-step
      // model (Turbo) then brings its own steps and CFG, as picking it by hand does.
      const sampling = source.modelBundleId ? { steps: source.steps, cfg: source.cfg } : samplingForBundle(source, null, choice.bundle)
      // The run keeps what it was really generated with, so running it again repeats it.
      const snapshot = generatedSnapshot(source, generating)
      const runSource: ProjectCanvas = { ...source, ...sampling, seed, modelBundleId: choice.bundle.id }
      if (snapshot) runSource.generated = snapshot
      else delete runSource.generated
      // An editable source remembers the seed this run used, so 种子 shows it
      // afterwards. A result card's parameters are frozen and stay as they were.
      // A 画面's old failed or stopped runs (no longer shown in its filmstrip) are cleared.
      const stale = new Set(source.kind === 'layout' ? staleRunIds(source.id, canvases, jobs) : [])
      const withSeed =
        source.kind === 'layout'
          ? canvases
              .filter((canvas) => !stale.has(canvas.id))
              .map((canvas) =>
                canvas.id === source.id
                  ? { ...canvas, ...sampling, width: source.width, height: source.height, seed, modelBundleId: choice.bundle!.id }
                  : canvas,
              )
          : canvases
      // Queued behind runs that are going: the picture picked in the strip stays on the face and the wires.
      const going = runs.some((run) => ACTIVE_JOB_STATES.has(run.jobState ?? ''))
      const task = taskCanvasFor(runSource, withSeed, crypto.randomUUID(), going)
      // The selection stays where the user is working; a 画面's run joins its filmstrip.
      project.setCanvases(task.canvases)
      return {
        taskId: task.taskId,
        source: runSource,
        generating,
        canvases,
        bundle: choice.bundle,
        prompt: compiled.prompt,
        adapters,
        sampling,
        seed,
        remoteHost,
        remoteModelPath,
      }
    },
    [],
  )

  /** Sends a prepared run, when its turn comes. */
  const send = useCallback(
    async (run: PreparedRun): Promise<RunResult> => {
      const { project, controlAdapters = [], controlAdaptersLoaded, notify } = latest.current
      const { taskId, source, remoteHost } = run
      const present = (): boolean => project.canvasesRef.current.some((canvas) => canvas.id === taskId)
      // Called off while it waited its turn: it never goes out.
      if (!present()) return { queued: false, error: '已取消' }
      const drop = (): void => project.setCanvases((previous) => previous.filter((canvas) => canvas.id !== taskId))
      try {
        // Pictures and sampling choices are checked against the engine this run goes to.
        const features =
          source.inputs || source.sampling
            ? await call<EngineFeatures | null>(Ipc.engineFeatures, {
                deviceUuid: remoteHost ? undefined : source.deviceUuid || undefined,
                hostId: remoteHost?.id,
              }).catch(() => null)
            : null
        const resolved = resolveJobInputs(run.generating, { canvases: run.canvases, features, controlAdapters, controlAdaptersLoaded })
        if (resolved.blockers.length) {
          // Refused before it went out: nothing to keep on the board.
          drop()
          return fail(resolved.blockers[0]!.message)
        }
        if (!present()) return { queued: false, error: '已取消' }
        const saved = await project.saveNow({ canvases: project.canvasesRef.current, selectedCanvasId: project.selectedRef.current })
        if (!saved) throw new Error('项目没有保存成功，请稍后再试')

        let info = backend.current
        if (!info?.ready) {
          info = await electronStudioClient.backendInfo().catch(() => null)
          backend.current = info
        }
        if (!info?.ready || !info.url || !info.token) throw new Error('生成服务还在启动，请稍等几秒再试')

        const controller = new AbortController()
        const timer = window.setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS)
        let body: unknown
        let response: Response
        try {
          response = await fetch(`${info.url}/api/engine-jobs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
            signal: controller.signal,
            body: JSON.stringify({
              projectId: saved.id,
              canvasId: taskId,
              // Activity names the job after the card it draws on, as the card itself does.
              // A 画面's runs are named after the 画面, where they show.
              canvasTitle: source.kind === 'layout' ? source.title : `${source.title} · 结果`,
              // Lineage starts at the source, as the scheduler expects.
              canvasLineage: canvasLineage(source, run.canvases),
              modelBinding: { bundleId: run.bundle.id, ...run.bundle.components },
              modelName: run.bundle.name,
              deviceId: remoteHost ? source.deviceId || undefined : undefined,
              deviceUuid: remoteHost ? undefined : source.deviceUuid || undefined,
              hostId: remoteHost?.id,
              remoteModelPath: remoteHost ? run.remoteModelPath : undefined,
              prompt: run.prompt,
              negativePrompt: source.negative,
              adapters: run.adapters,
              ...resolved.params,
              width: resolved.size.width,
              height: resolved.size.height,
              steps: run.sampling.steps,
              cfg: run.sampling.cfg,
              seed: run.seed,
              profile: profileFor(run.sampling.steps),
              mode: 'runner',
            }),
          })
          body = await response.json().catch(() => null)
        } catch (error) {
          if (controller.signal.aborted) throw new Error('生成服务没有回应，这一张没有发出去，请再试一次')
          throw error
        } finally {
          window.clearTimeout(timer)
        }
        if (!response.ok) throw new Error(errorMessage(body, response.status))
        if (!isJobRecord(body)) throw new Error('生成服务返回了无法识别的任务')
        const jobId = body.id
        if (!present()) {
          // Called off while it was being sent: the engine must not draw it either.
          await call(Ipc.jobCancel, { id: jobId }).catch(() => undefined)
          return { queued: false, error: '已取消' }
        }
        const observed = useApp.getState().jobs.find((job) => job.id === jobId)
        const state = body.state
        project.setCanvases((previous) =>
          previous.map((canvas) =>
            canvas.id === taskId
              ? {
                  ...canvas,
                  jobId,
                  jobState: observed?.state ?? state,
                  deviceId: body.deviceId ?? canvas.deviceId,
                  deviceUuid: body.deviceUuid ?? canvas.deviceUuid,
                }
              : canvas,
          ),
        )
        const linked = await project.saveNow()
        if (!linked) notify('已开始生成，但项目没有保存成功；进度可以在「活动」里查看', 'error')
        return { queued: true, canvasId: taskId, jobId }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        project.setCanvases((previous) =>
          previous.map((canvas) =>
            canvas.id === taskId ? { ...canvas, jobState: 'failed', error: { code: 'E_SUBMIT', message } } : canvas,
          ),
        )
        void project.saveNow()
        return fail(message)
      }
    },
    [fail],
  )

  const generate = useCallback(
    (canvasId?: string, seedMode: SeedMode = 'auto', runOptions: { smaller?: boolean } = {}): Promise<RunResult> => {
      // The canvas and its settings are taken now, at the click, whatever happens before its turn.
      const prepared = prepare(canvasId ?? latest.current.project.selectedRef.current, seedMode, runOptions)
      if ('error' in prepared) return Promise.resolve(fail(prepared.error))
      const go = (): Promise<RunResult> => send(prepared)
      const result = chain.current.then(go, go)
      chain.current = result.catch(() => undefined)
      return result
    },
    [prepare, send, fail],
  )

  return { generate }
}
