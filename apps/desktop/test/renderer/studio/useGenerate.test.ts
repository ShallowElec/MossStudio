import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MAX_QUEUED_RUNS } from '@shared/canvasJobBranch'
import type { ProjectCanvas } from '@shared/types'
import { catalogFixture, createMockBackend, SFT_BUNDLE_IDS } from '@test/mocks/backend'
import { useGenerate } from '@renderer/pages/studio/useGenerate'
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

/** The hook over an in-memory board; the backend's job route answers every submission with a queued job. */
function mount(start: ProjectCanvas[]) {
  const backend = createMockBackend('ready')
  uninstall = backend.install()
  const sent: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (!url.endsWith('/api/engine-jobs')) throw new Error(`unexpected fetch ${url}`)
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    sent.push(body)
    return new Response(JSON.stringify({ id: `job-${sent.length}`, state: 'queued' }), { status: 200 })
  })
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
  return { api: () => api!, board, sent, notify }
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
})
