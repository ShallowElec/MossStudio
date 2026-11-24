import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MAX_QUEUED_RUNS } from '@shared/canvasJobBranch'
import { Ipc } from '@shared/channels'
import type { Catalog, ManagedHost, ProjectCanvas } from '@shared/types'
import { workerCanvasAdapter, type RemoteWorkerModelInventory } from '@shared/remoteWorker'
import { workerAdapterEntries, type WorkerAdapterEntry, type WorkerModelPick } from '@renderer/pages/studio/remoteWorkerLoras'
import { catalogFixture, createMockBackend, SFT_BUNDLE_IDS } from '@test/mocks/backend'
import { SUBMIT_TIMEOUT_MS, useGenerate } from '@renderer/pages/studio/useGenerate'
import { dropRun, queuedRunsOf, runsOf } from '@renderer/pages/studio/runs'
import type { StudioProject } from '@renderer/pages/studio/useStudioProject'
import { withDescription } from '@renderer/pages/studio/prompt'
import { canvas } from './fixtures'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let root: Root | null = null
let uninstall: (() => void) | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  uninstall?.()
  uninstall = null
})

const scene = (patch: Partial<ProjectCanvas> = {}): ProjectCanvas =>
  withDescription(canvas({ id: 'scene', seedLocked: false, ...patch }), '海边的灯塔')
const result = (id: string, patch: Partial<ProjectCanvas> = {}): ProjectCanvas =>
  canvas({ id, kind: 'result', sourceCanvasId: 'scene', title: '画面 1 · 结果', prompt: '海边的灯塔', ...patch })

/**
 * The hook over an in-memory board; the backend's job route answers every submission with a queued job.
 * `held`: each submission waits for `release()` (or never answers), and gives up when its request is aborted.
 */
function mount(
  start: ProjectCanvas[],
  options: {
    held?: boolean
    catalog?: Catalog
    remoteHost?: ManagedHost | null
    workerAdapters?: readonly WorkerAdapterEntry[] | null
    /** What the Worker daemon lists; an older daemon's answer unless given. */
    workerModels?: RemoteWorkerModelInventory | null
    workerModelPick?: WorkerModelPick | null
  } = {},
) {
  const backend = createMockBackend('ready')
  uninstall = backend.install()
  const sent: Array<Record<string, unknown>> = []
  const waiting: Array<() => void> = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (!url.endsWith('/api/engine-jobs')) throw new Error(`unexpected fetch ${url}`)
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    sent.push(body)
    const id = `job-${sent.length}`
    if (options.held) {
      await new Promise<void>((resolve, reject) => {
        waiting.push(resolve)
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }
    return new Response(JSON.stringify({ id, state: 'queued' }), { status: 200 })
  })
  /** Let the oldest held submission answer. */
  const release = async (): Promise<void> => {
    await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0))
    waiting.shift()!()
  }
  const board = { current: start }
  const notify = vi.fn()
  const project = {
    canvasesRef: board,
    selectedRef: { current: 'scene' },
    // A run's writes are saved but never an undo step: they must not use the recording setter.
    setCanvases: () => {
      throw new Error('a run wrote through setCanvases, which records an undo step')
    },
    setRunCanvases: (next: ProjectCanvas[] | ((previous: ProjectCanvas[]) => ProjectCanvas[])) => {
      board.current = typeof next === 'function' ? next(board.current) : next
    },
    saveNow: async () => ({ id: 'project-1' }),
  } as unknown as StudioProject
  let api: ReturnType<typeof useGenerate> | null = null
  function Probe(): null {
    api = useGenerate({
      project,
      catalog: options.catalog ?? catalogFixture({ installed: SFT_BUNDLE_IDS }),
      preferredBundleId: null,
      remoteHost: options.remoteHost ?? null,
      workerAdapters: options.workerAdapters,
      workerModels: options.workerModels === undefined ? { models: [], components: [], unsupported: true } : options.workerModels,
      workerModelPick: options.workerModelPick,
      notify,
    })
    return null
  }
  root = createRoot(document.createElement('div'))
  act(() => root!.render(createElement(Probe)))
  return { api: () => api!, board, sent, notify, release, backend }
}

describe('studio/useGenerate', () => {
  it('queues every click: three quick ones send three runs, one after another', async () => {
    const { api, board, sent } = mount([scene()])
    const results = await Promise.all([api().generate('scene'), api().generate('scene'), api().generate('scene')])
    expect(results.map((item) => item.queued)).toEqual([true, true, true])
    expect(sent).toHaveLength(3)
    // Each run draws into a result of its own, linked to its job, in the order asked for.
    const runs = board.current.filter((item) => item.kind === 'result')
    expect(runs.map((item) => item.jobId)).toEqual(['job-1', 'job-2', 'job-3'])
    expect(sent.map((body) => body['canvasId'])).toEqual(runs.map((item) => item.id))
    expect(new Set(sent.map((body) => body['seed'])).size).toBe(3)
  })

  it('sends each run with the settings of the moment it was asked for; later edits do not reach it', async () => {
    const { api, board, sent } = mount([scene()])
    const edit = (patch: (item: ProjectCanvas) => ProjectCanvas): void => {
      board.current = board.current.map((item) => (item.id === 'scene' ? patch(item) : item))
    }
    const first = api().generate('scene')
    edit((item) => ({ ...withDescription(item, '雨夜的街道'), width: 1280, height: 720 }))
    const second = api().generate('scene')
    await Promise.all([first, second])
    edit((item) => withDescription(item, '窗台上的猫'))

    expect(sent.map((body) => [body['prompt'], body['width'], body['height']])).toEqual([
      ['海边的灯塔', 1024, 1024],
      ['雨夜的街道', 1280, 720],
    ])
    // The queued run's own card keeps what it was sent with.
    const runs = board.current.filter((item) => item.kind === 'result')
    expect(runs.map((item) => [item.prompt, item.width])).toEqual([
      ['海边的灯塔', 1024],
      ['雨夜的街道', 1280],
    ])
  })

  it(`refuses a run once ${MAX_QUEUED_RUNS} wait behind the one being drawn`, async () => {
    const waiting = Array.from({ length: MAX_QUEUED_RUNS }, (_, index) => result(`q${index}`, { jobId: `q${index}`, jobState: 'queued' }))
    const { api, sent, notify } = mount([scene(), result('drawing', { jobId: 'd', jobState: 'running' }), ...waiting])
    expect(await api().generate('scene')).toEqual({ queued: false, error: '排队已满，等前面的画完再加' })
    expect(notify).toHaveBeenCalledWith('排队已满，等前面的画完再加', 'error')
    expect(sent).toHaveLength(0)
  })

  it('still refuses a 画面 whose source is being drawn by a run started elsewhere', async () => {
    const pinned = result('pinned', { pinned: true, jobState: 'succeeded' })
    const again = result('again', { sourceCanvasId: 'pinned', jobId: 'a', jobState: 'running' })
    const { api, sent } = mount([scene(), pinned, again])
    expect(await api().generate('scene')).toMatchObject({ queued: false, error: '这个画面或它的来源正在生成，等它完成后再试' })
    expect(sent).toHaveLength(0)
  })

  it('takes the settings at the click, even while an earlier run is still being sent', async () => {
    const { api, board, sent, release } = mount([scene()], { held: true })
    const first = api().generate('scene')
    const second = api().generate('scene')
    // Edited after both clicks, while the first is still on its way.
    board.current = board.current.map((item) => (item.id === 'scene' ? withDescription(item, '雨夜的街道') : item))
    await release()
    await release()
    await Promise.all([first, second])
    expect(sent.map((body) => body['prompt'])).toEqual(['海边的灯塔', '海边的灯塔'])
  })

  it('never sends a run called off while it waited its turn, and counts it while it waits', async () => {
    const { api, board, sent, release, notify } = mount([scene()], { held: true })
    const calls = [1, 2, 3, 4].map(() => api().generate('scene', 'new'))
    // Each click put its run on the board at once: one being sent, three waiting behind it.
    const runs = board.current.filter((item) => item.kind === 'result')
    expect(runs).toHaveLength(4)
    expect(queuedRunsOf(runsOf(board.current[0]!, board.current)).map((item) => item.id)).toEqual(runs.slice(1).map((item) => item.id))
    // 取消排队: the three not sent yet go.
    for (const run of runs.slice(1)) board.current = dropRun(board.current, run.id)
    await release()
    const results = await Promise.all(calls)
    expect(sent).toHaveLength(1)
    expect(results.map((item) => item.queued)).toEqual([true, false, false, false])
    expect(notify).not.toHaveBeenCalled()
  })

  it('calls the engine job off when its run was called off while it was being sent', async () => {
    const { api, board, release, backend } = mount([scene()], { held: true })
    const call = api().generate('scene')
    const run = board.current.find((item) => item.kind === 'result')!
    await vi.waitFor(() => expect(board.current.some((item) => item.id === run.id)).toBe(true))
    board.current = dropRun(board.current, run.id)
    await release()
    expect(await call).toMatchObject({ queued: false })
    expect(backend.callsTo(Ipc.jobCancel)).toEqual([{ id: 'job-1' }])
  })

  it(`gives up on a run the backend does not accept within ${SUBMIT_TIMEOUT_MS / 1000} s, and sends the next`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { api, board, sent, notify } = mount([scene()], { held: true })
      const first = api().generate('scene')
      const second = api().generate('scene')
      await vi.advanceTimersByTimeAsync(SUBMIT_TIMEOUT_MS)
      expect(await first).toEqual({ queued: false, error: '生成服务没有回应，这一张没有发出去，请再试一次' })
      expect(notify).toHaveBeenCalledWith('生成服务没有回应，这一张没有发出去，请再试一次', 'error')
      const failed = board.current.find((item) => item.kind === 'result' && item.jobState === 'failed')
      expect(failed?.error).toMatchObject({ code: 'E_SUBMIT' })
      // The chain goes on: the second run is sent.
      await vi.waitFor(() => expect(sent).toHaveLength(2))
      await vi.advanceTimersByTimeAsync(SUBMIT_TIMEOUT_MS)
      await second
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('studio/useGenerate on a Worker host', () => {
  const worker = (patch: Partial<ManagedHost> = {}): ManagedHost => ({
    id: 'h1',
    name: 'render-box',
    kind: 'ssh',
    remoteBackend: 'worker-daemon',
    trainerRoot: '',
    status: 'ok',
    devices: [],
    ...patch,
  })
  const nothingHere = (): Catalog => ({ ...catalogFixture({ installed: [] }), adapters: [] })
  const entries = workerAdapterEntries([
    { id: 'anime.safetensors', name: 'Anime', sizeBytes: 1, registered: true },
    { id: 'styles/ink.safetensors', name: 'Ink', sizeBytes: 1, registered: true },
    { id: 'old.safetensors', name: 'Old', sizeBytes: 1, registered: false },
  ])

  it('sends with hostId and the Worker model when nothing is downloaded here, with the Worker LoRA', async () => {
    const ink = workerCanvasAdapter('styles/ink.safetensors', 0.8)
    const start = scene({ adapters: [{ id: 'anime.safetensors', strength: 1 }, ink] })
    const { api, board, sent, notify } = mount([start], { catalog: nothingHere(), remoteHost: worker(), workerAdapters: entries })
    expect(await api().generate('scene')).toMatchObject({ queued: true })
    expect(notify).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      hostId: 'h1',
      modelName: 'render-box',
      modelBinding: { bundleId: 'remote-worker:worker-h1' },
      adapters: [{ id: 'anime.safetensors', strength: 1 }, ink],
    })
    expect(sent[0]!['remoteModelPath']).toBeUndefined()
    // The 画面 keeps naming no model of its own: back on this computer it resolves as before.
    expect(board.current.find((item) => item.id === 'scene')?.modelBundleId).toBeUndefined()
  })

  it('uses the custom provider id and does not report LoRA missing while the Worker list is unknown', async () => {
    const start = scene({ adapters: [{ id: 'anime.safetensors', strength: 1 }] })
    const { api, sent } = mount([start], {
      catalog: nothingHere(),
      remoteHost: worker({ workerProviderId: 'gpu-a' }),
      workerAdapters: null,
    })
    expect(await api().generate('scene')).toMatchObject({ queued: true })
    expect(sent[0]).toMatchObject({ hostId: 'h1', modelBinding: { bundleId: 'remote-worker:gpu-a' } })
  })

  it('never negotiates a legacy Worker binding against this computer’s sampler list', async () => {
    const id = 'remote-worker:render'
    const catalog = nothingHere()
    catalog.models.push({ ...catalog.models[0]!, id, installed: true })
    catalog.bundles.push({ ...catalog.bundles[0]!, id, support: id, components: { dit: id, textEncoder: id, vae: id } })
    const { api, sent, backend } = mount([scene({ modelBundleId: id, sampling: { sampler: 'euler' } })], { catalog })
    expect(await api().generate('scene')).toMatchObject({ queued: false, error: expect.stringMatching(/远端.*采样器/) })
    expect(backend.callsTo(Ipc.engineFeatures)).toEqual([])
    expect(sent).toEqual([])
  })

  it('refuses old sampling before posting a Worker run even if the capability probe fails', async () => {
    const { api, sent, backend } = mount([scene({ sampling: { shift: 4 } })], { remoteHost: worker() })
    backend.handle(Ipc.engineFeatures, () => null)
    expect(await api().generate('scene')).toMatchObject({ queued: false, error: expect.stringMatching(/远端.*采样器.*调度器/) })
    expect(sent).toEqual([])
  })

  it('refuses a LoRA the Worker has not registered, naming the host', async () => {
    const start = scene({ adapters: [{ id: 'old.safetensors', strength: 1 }] })
    const { api, sent } = mount([start], { catalog: nothingHere(), remoteHost: worker(), workerAdapters: entries })
    expect(await api().generate('scene')).toEqual({
      queued: false,
      error: '「render-box」上没有登记 LoRA 「Old」，请移除或在 LoRA 列表里登记',
    })
    expect(sent).toHaveLength(0)
  })

  // Worker ids differ from catalog ids on purpose: only the catalog id may reach the 画面.
  const inventory: RemoteWorkerModelInventory = {
    models: [
      { id: 'sft-int8', name: 'SFT INT8', catalogBundleId: 'moss-sft-int8' },
      { id: 'my-finetune', name: 'My finetune' },
    ],
    components: [],
  }

  it('runs the Worker model under its own id while the 画面 keeps its catalog model', async () => {
    const picked = mount([scene({ modelBundleId: 'moss-sft' })], {
      remoteHost: worker(),
      workerModels: inventory,
      workerModelPick: { id: 'my-finetune', over: 'moss-sft' },
    })
    expect(await picked.api().generate('scene')).toMatchObject({ queued: true })
    expect(picked.sent[0]).toMatchObject({ hostId: 'h1', modelName: 'My finetune', modelBinding: { bundleId: 'my-finetune' } })
    expect(picked.board.current.filter((item) => item.modelBundleId === 'my-finetune')).toEqual([])
    expect(picked.board.current.find((item) => item.id === 'scene')?.modelBundleId).toBe('moss-sft')
    act(() => root?.unmount())
    uninstall?.()
    const twin = mount([scene({ modelBundleId: 'moss-sft-int8' })], { remoteHost: worker(), workerModels: inventory })
    expect(await twin.api().generate('scene')).toMatchObject({ queued: true })
    expect(twin.sent[0]).toMatchObject({ modelBinding: { bundleId: 'sft-int8' } })
    expect(twin.board.current.map((item) => item.modelBundleId)).not.toContain('sft-int8')
  })

  it('runs a 画面’s own model when the Worker has it, not a pick made over another model', async () => {
    const { api, sent } = mount([scene({ modelBundleId: 'moss-sft-int8' })], {
      remoteHost: worker(),
      workerModels: inventory,
      workerModelPick: { id: 'my-finetune', over: 'moss-sft' },
    })
    expect(await api().generate('scene')).toMatchObject({ queued: true })
    expect(sent[0]).toMatchObject({ modelBinding: { bundleId: 'sft-int8' } })
  })

  it('waits until the Worker’s model list is read rather than run its default model', async () => {
    const { api, sent } = mount([scene()], { remoteHost: worker(), workerModels: null })
    expect(await api().generate('scene')).toEqual({ queued: false, error: '还没有读到「render-box」上的模型，请稍后再试' })
    expect(sent).toHaveLength(0)
  })

  it('treats a LoRA at strength 0 as off on this computer: not required, not sent', async () => {
    const { api, sent } = mount([scene({ adapters: [{ id: 'gone.safetensors', strength: 0 }] })])
    expect(await api().generate('scene')).toMatchObject({ queued: true })
    expect(sent[0]!['adapters'] ?? []).toEqual([])
  })

  it('keeps every local check for a person with no Worker', async () => {
    const local = mount([scene()], { catalog: nothingHere(), workerAdapters: entries })
    expect(await local.api().generate('scene')).toEqual({ queued: false, error: '还没有可用的模型，请先到模型页下载' })
    expect(local.sent).toHaveLength(0)
    act(() => root?.unmount())
    uninstall?.()
    const withLora = mount([scene({ adapters: [{ id: 'anime.safetensors', strength: 1 }] })], { workerAdapters: entries })
    expect((await withLora.api().generate('scene')).error).toContain('找不到了')
    const ssh = worker({ id: 'h2', remoteBackend: 'moss-ssh', modelPath: '' })
    act(() => root?.unmount())
    uninstall?.()
    const sshRun = mount([scene()], { remoteHost: ssh })
    expect((await sshRun.api().generate('scene')).error).toBe('「render-box」还没有设置模型位置，请到 设置 › 设备与引擎 填写')
  })
})
