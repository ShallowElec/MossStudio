import { describe, expect, it } from 'vitest'
import { activeCanvasBranchIds, blockedCanvasIds, type CanvasBranch, canvasBranchesConflict, canvasLineage } from '@shared/canvasJobBranch'
import type { JobRecord, JobState, ProjectCanvas } from '@shared/types'

const canvas = (id: string, sourceCanvasId?: string, overrides: Partial<ProjectCanvas> = {}): ProjectCanvas => ({
  id,
  kind: sourceCanvasId ? 'result' : 'layout',
  title: id,
  sourceCanvasId,
  width: 512,
  height: 512,
  x: 0,
  y: 0,
  summary: { caption: '', meta: [], canvas: 'single' },
  layers: [],
  prompt: 'test',
  negative: '',
  seed: 1,
  steps: 4,
  cfg: 1,
  ...overrides,
})

// activeCanvasBranchIds only reads `id` and `state`; the rest of JobRecord is irrelevant.
const job = (id: string, state: JobState) => ({ id, state }) as JobRecord

const canvases = [canvas('root'), canvas('child', 'root'), canvas('grandchild', 'child'), canvas('sibling', 'root'), canvas('other-root')]

const withJob = (id: string, extra: Partial<ProjectCanvas>) => canvases.map((item) => (item.id === id ? { ...item, ...extra } : item))

describe('activeCanvasBranchIds', () => {
  it('locks an active descendant and its ancestors, not a sibling result', () => {
    const busy = activeCanvasBranchIds(withJob('grandchild', { jobId: 'job' }), [job('job', 'running')])
    expect([...busy].sort()).toEqual(['child', 'grandchild', 'root'])
    expect(busy.has('sibling')).toBe(false)
    expect(busy.has('other-root')).toBe(false)
  })

  it.each<JobState>(['queued', 'starting', 'running'])('treats %s as active', (state) => {
    expect([...activeCanvasBranchIds(withJob('child', { jobId: 'j' }), [job('j', state)])].sort()).toEqual(['child', 'root'])
  })

  it.each<JobState>(['succeeded', 'failed', 'canceled'])('treats %s as finished', (state) => {
    expect(activeCanvasBranchIds(withJob('child', { jobId: 'j' }), [job('j', state)]).size).toBe(0)
  })

  it('lets the live job record override a stale canvas jobState', () => {
    const stale = withJob('child', { jobId: 'j', jobState: 'running' })
    expect(activeCanvasBranchIds(stale, [job('j', 'succeeded')]).size).toBe(0)
  })

  it('falls back to the canvas jobState when the job is unknown or absent', () => {
    expect([...activeCanvasBranchIds(withJob('child', { jobId: 'gone', jobState: 'queued' }), [])].sort()).toEqual(['child', 'root'])
    expect([...activeCanvasBranchIds(withJob('sibling', { jobState: 'starting' }), [job('x', 'running')])].sort()).toEqual([
      'root',
      'sibling',
    ])
    expect(activeCanvasBranchIds(canvases, [job('x', 'running')]).size).toBe(0)
  })

  it('unions the branches of several active canvases', () => {
    const many = canvases.map((item) =>
      item.id === 'grandchild' || item.id === 'other-root' ? { ...item, jobState: 'running' as const } : item,
    )
    expect([...activeCanvasBranchIds(many, [])].sort()).toEqual(['child', 'grandchild', 'other-root', 'root'])
  })

  it('stops at a dangling source and survives cycles', () => {
    expect([...activeCanvasBranchIds([canvas('orphan', 'missing', { jobState: 'running' })], [])]).toEqual(['orphan'])
    const cycle = [canvas('a', 'b', { jobState: 'running' }), canvas('b', 'a')]
    expect([...activeCanvasBranchIds(cycle, [])].sort()).toEqual(['a', 'b'])
  })
})

describe('canvasLineage', () => {
  it('lists the canvas and each ancestor once, nearest first', () => {
    expect(canvasLineage(canvases[2]!, canvases)).toEqual(['grandchild', 'child', 'root'])
    expect(canvasLineage(canvases[0]!, canvases)).toEqual(['root'])
  })

  it('includes a canvas that is not in the list itself', () => {
    expect(canvasLineage(canvas('detached', 'child'), canvases)).toEqual(['detached', 'child', 'root'])
  })

  it('stops at a dangling source and at cycles', () => {
    expect(canvasLineage(canvas('orphan', 'missing'), [])).toEqual(['orphan'])
    const cycle = [canvas('a', 'c'), canvas('b', 'a'), canvas('c', 'b')]
    expect(canvasLineage(cycle[0]!, cycle)).toEqual(['a', 'c', 'b'])
    const self = canvas('self', 'self')
    expect(canvasLineage(self, [self])).toEqual(['self'])
  })
})

describe('canvasBranchesConflict', () => {
  const root: CanvasBranch = { sourceId: 'root', path: new Set(['root']) }
  const child: CanvasBranch = { sourceId: 'child', path: new Set(['child', 'root']) }
  const sibling: CanvasBranch = { sourceId: 'sibling', path: new Set(['sibling', 'root']) }
  const other: CanvasBranch = { sourceId: 'other', path: new Set(['other']) }

  it('blocks ancestors and descendants without blocking siblings', () => {
    expect(canvasBranchesConflict(root, child)).toBe(true)
    expect(canvasBranchesConflict(child, sibling)).toBe(false)
  })

  it('is symmetric', () => {
    expect(canvasBranchesConflict(child, root)).toBe(true)
    expect(canvasBranchesConflict(sibling, child)).toBe(false)
  })

  it('lets runs started from the same canvas queue, and never conflicts with an unrelated tree', () => {
    // Two runs of one 画面: each draws into its own result, both start from the 画面.
    expect(
      canvasBranchesConflict(
        { sourceId: 'root', path: new Set(['run-1', 'root']) },
        { sourceId: 'root', path: new Set(['run-2', 'root']) },
      ),
    ).toBe(false)
    expect(canvasBranchesConflict(child, { sourceId: 'child', path: new Set(['child', 'root']) })).toBe(false)
    expect(canvasBranchesConflict(root, other)).toBe(false)
  })

  it('only looks at source ids, not shared ancestors', () => {
    // Two results of the same root share `root` in their paths but neither contains the other.
    expect(canvasBranchesConflict({ sourceId: 'x', path: new Set(['x', 'root']) }, { sourceId: 'y', path: new Set(['y', 'root']) })).toBe(
      false,
    )
  })
})

describe('blockedCanvasIds', () => {
  const layout = canvas('scene')
  const run = (id: string, state: JobState | undefined, source = 'scene') =>
    canvas(id, source, state ? { jobId: `job-${id}`, jobState: state } : {})
  const jobsOf = (list: ProjectCanvas[]) => list.filter((item) => item.jobId).map((item) => job(item.jobId!, item.jobState!))

  it('does not block a 画面 whose own runs are going: another run queues behind them', () => {
    const list = [layout, run('done', 'succeeded'), run('drawing', 'running'), run('waiting', 'queued')]
    const blocked = blockedCanvasIds(list, jobsOf(list))
    expect(blocked.has('scene')).toBe(false)
    // A run that is still going cannot be started again from its own card, nor can a sibling result while its 画面 draws.
    expect(blocked.has('drawing')).toBe(true)
    expect(blocked.has('done')).toBe(true)
  })

  it('blocks a 画面 while a run started from a result in its lineage goes', () => {
    const list = [layout, run('pinned', 'succeeded'), run('again', 'running', 'pinned')]
    const blocked = blockedCanvasIds(list, jobsOf(list))
    expect(blocked.has('scene')).toBe(true)
    // The result it was started from may queue another run of its own.
    expect(blocked.has('pinned')).toBe(false)
  })

  it('blocks nothing once every run has ended, and leaves other trees alone', () => {
    const list = [layout, run('done', 'succeeded'), canvas('other'), run('other-run', 'running', 'other')]
    expect([...blockedCanvasIds(list, jobsOf(list))]).toEqual(['other-run'])
    const ended = list.map((item) => (item.id === 'other-run' ? { ...item, jobState: 'succeeded' as const } : item))
    expect(blockedCanvasIds(ended, jobsOf(ended)).size).toBe(0)
  })
})
