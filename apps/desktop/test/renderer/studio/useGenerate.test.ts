import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MAX_QUEUED_RUNS } from '@shared/canvasJobBranch'
import { Ipc } from '@shared/channels'
import type { ProjectCanvas } from '@shared/types'
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
function mount(start: ProjectCanvas[], options: { held?: boolean } = {}) {
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
    setCanvases: (next: ProjectCanvas[] | ((previous: ProjectCanvas[]) => ProjectCanvas[])) => {
      board.current = typeof next === 'function' ? next(board.current) : next
    },
    saveNow: async () => ({ id: 'project-1' }),
  } as unknown as StudioProject
  let api: ReturnType<typeof useGenerate> | null = null
  function Probe(): null {
    api = useGenerate({
      project,
      catalog: catalogFixture({ installed: SFT_BUNDLE_IDS }),
      preferredBundleId: null,
      remoteHost: null,
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
