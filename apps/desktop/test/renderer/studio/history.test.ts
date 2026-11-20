import { describe, expect, it } from 'vitest'
import type { ProjectCanvas } from '@shared/types'
import {
  applyStep,
  createHistory,
  diffCanvases,
  HISTORY_LIMIT,
  isEmptyStep,
  record,
  stepLabel,
  turnState,
  turnSteps,
  type BoardHistory,
} from '@renderer/pages/studio/history'
import { removeCanvasFrom } from '@renderer/pages/studio/canvases'
import { setLink } from '@renderer/pages/studio/links'
import { canvas, layer } from './fixtures'

const picture = (id: string, patch: Partial<ProjectCanvas> = {}): ProjectCanvas =>
  canvas({ id, kind: 'image', title: id, imagePath: `/p/${id}.png`, ...patch })
const run = (id: string, source: string, patch: Partial<ProjectCanvas> = {}): ProjectCanvas =>
  canvas({
    id,
    kind: 'result',
    sourceCanvasId: source,
    jobId: `job-${id}`,
    jobState: 'succeeded',
    outputs: [{ path: `/out/${id}.png`, width: 1024, height: 1024, seed: 1 }],
    ...patch,
  })

/** Record the change from `before` to `after` as one edit. */
function edit(
  history: BoardHistory,
  before: ProjectCanvas[],
  after: ProjectCanvas[],
  token = 't',
  extra: { label?: string; call?: string } = {},
) {
  record(history, diffCanvases(before, after), { token, selected: before[0]?.id ?? null, ...extra })
  return after
}

describe('studio/history diffCanvases', () => {
  it('finds added, removed and edited canvases, and ignores what a run writes', () => {
    const a = canvas({ id: 'a' })
    const b = canvas({ id: 'b', title: '画面 2' })
    const before = [a, b]
    const ran = {
      ...a,
      jobId: 'j',
      jobState: 'running' as const,
      progress: { stage: 'denoise' as const, current: 1, total: 4, percent: 25 },
    }
    expect(diffCanvases(before, [ran, b])).toEqual([])
    expect(diffCanvases(before, [{ ...a, shownOutput: { canvasId: 'r' } }, b])).toEqual([])
    const moved = { ...b, x: 40 }
    const added = canvas({ id: 'c' })
    expect(diffCanvases(before, [moved, added]).map((change) => [change.id, Boolean(change.before), Boolean(change.after)])).toEqual([
      ['b', true, true],
      ['c', false, true],
      ['a', true, false],
    ])
    // Rebuilt but equal objects are not a change.
    expect(diffCanvases(before, [{ ...a, layers: [...a.layers] }, b])).toEqual([])
  })
})

describe('studio/history record', () => {
  it('joins edits with the same token into one step and starts a new one otherwise', () => {
    const history = createHistory()
    let list = [canvas({ id: 'a' })]
    list = edit(history, list, [{ ...list[0]!, prompt: 'a' }], 'field:1')
    list = edit(history, list, [{ ...list[0]!, prompt: 'a c' }], 'field:1')
    list = edit(history, list, [{ ...list[0]!, prompt: 'a ca' }], 'field:1')
    expect(history.undo).toHaveLength(1)
    expect(history.undo[0]!.before.get('a')!.prompt).toBe('')
    expect(history.undo[0]!.after.get('a')!.prompt).toBe('a ca')
    edit(history, list, [{ ...list[0]!, x: 10 }], 'tick:2')
    expect(history.undo).toHaveLength(2)
  })

  it('clears what could be redone when a new edit comes, and nothing joins a step after an undo', () => {
    const history = createHistory()
    const list = edit(history, [canvas({ id: 'a' })], [canvas({ id: 'a', x: 5 })], 'same')
    history.redo.push(history.undo.pop()!)
    history.sealed = true
    edit(history, list, [canvas({ id: 'a', x: 9 })], 'same')
    expect(history.undo).toHaveLength(1)
    expect(history.redo).toHaveLength(0)
  })

  it(`keeps the latest ${HISTORY_LIMIT} steps`, () => {
    const history = createHistory()
    let list = [canvas({ id: 'a' })]
    for (let index = 1; index <= HISTORY_LIMIT + 20; index += 1) list = edit(history, list, [{ ...list[0]!, x: index }], `tick:${index}`)
    expect(history.undo).toHaveLength(HISTORY_LIMIT)
    expect(history.undo[0]!.before.get('a')!.x).toBe(20)
  })

  it('a step whose edits cancel out is empty', () => {
    const history = createHistory()
    let list = [canvas({ id: 'a', layers: [layer()] })]
    const original = list
    list = edit(history, list, [{ ...list[0]!, layers: [layer({ bbox: [10, 10, 500, 500] })] }], 'pointer:1')
    edit(history, list, [{ ...original[0]!, layers: [layer()] }], 'pointer:1')
    expect(isEmptyStep(history.undo[0]!)).toBe(true)
  })
})

describe('studio/history applyStep', () => {
  it('undoes a move but keeps a job that finished in between, then redoes it', () => {
    const history = createHistory()
    const start = [canvas({ id: 'a' }), run('r1', 'a', { jobState: 'running', outputs: [] })]
    const moved = edit(history, start, [{ ...start[0]!, x: 300, y: 80 }, start[1]!])
    // The job finishes and a new run starts on the 画面: neither is part of the step.
    const now = [
      { ...moved[0]!, seed: 99 },
      { ...moved[1]!, jobState: 'succeeded' as const, outputs: [{ path: '/out/r1.png', width: 1024, height: 1024, seed: 1 }] },
      run('r2', 'a', { jobState: 'queued', outputs: [] }),
    ]
    const undone = applyStep(now, history.undo[0]!, 'undo').canvases
    expect(undone.map((item) => item.id)).toEqual(['a', 'r1', 'r2'])
    expect([undone[0]!.x, undone[0]!.y, undone[0]!.seed]).toEqual([0, 0, 99])
    expect(undone[1]!.outputs).toHaveLength(1)
    expect(undone[1]!.jobState).toBe('succeeded')
    const redone = applyStep(undone, history.undo[0]!, 'redo').canvases
    expect([redone[0]!.x, redone[0]!.y]).toEqual([300, 80])
  })

  it('brings a deleted 画面 back in its place with its runs and pictures, and the wires to it', () => {
    const history = createHistory()
    const a = canvas({ id: 'a' })
    const user = setLink(canvas({ id: 'b', title: '画面 2' }), 'reference', { canvasId: 'r1' })
    const start = [a, run('r1', 'a', { pinned: true }), run('r2', 'a'), user]
    const after = removeCanvasFrom(start, 'a').canvases
    edit(history, start, after)
    expect(after.map((item) => item.id)).toEqual(['r1', 'b'])
    const { canvases: back, restored } = applyStep(after, history.undo[0]!, 'undo')
    expect(back.map((item) => item.id)).toEqual(['a', 'r1', 'r2', 'b'])
    expect(restored).toEqual(['a', 'r2'])
    expect(back[2]!.outputs?.[0]?.path).toBe('/out/r2.png')
  })

  it('takes an added card away again, but never a run with pictures', () => {
    const history = createHistory()
    const start = [canvas({ id: 'a' })]
    edit(history, start, [...start, picture('img')])
    expect(applyStep([...start, picture('img')], history.undo[0]!, 'undo').canvases.map((item) => item.id)).toEqual(['a'])

    const other = createHistory()
    const pinned = run('r', 'gone')
    edit(other, start, [...start, pinned])
    expect(applyStep([...start, pinned], other.undo[0]!, 'undo').canvases.map((item) => item.id)).toEqual(['a', 'r'])
  })

  it('does not bring back a card that something else removed since', () => {
    const history = createHistory()
    const start = [canvas({ id: 'a' }), run('stale', 'a', { pinned: true, jobState: 'failed', outputs: [] })]
    edit(history, start, [start[0]!, { ...start[1]!, x: 500 }])
    // A new run cleared the failed one.
    const now = [start[0]!]
    expect(applyStep(now, history.undo[0]!, 'undo').canvases.map((item) => item.id)).toEqual(['a'])
  })

  it('removes a field the step added and puts back one it removed', () => {
    const history = createHistory()
    const pinned = run('r', 'a', { pinned: true })
    const { pinned: _drop, ...unpinned } = pinned
    edit(history, [canvas({ id: 'a' }), pinned], [canvas({ id: 'a' }), unpinned])
    const back = applyStep([canvas({ id: 'a' }), unpinned], history.undo[0]!, 'undo').canvases
    expect(back[1]!.pinned).toBe(true)
    const again = applyStep(back, history.undo[0]!, 'redo').canvases
    expect('pinned' in again[1]!).toBe(false)
  })
})

describe('studio/history stepLabel', () => {
  const labelOf = (before: ProjectCanvas[], after: ProjectCanvas[], label?: string): string => {
    const history = createHistory()
    edit(history, before, after, 't', { label })
    return stepLabel(history.undo[0]!)
  }
  const a = canvas({ id: 'a', title: '画面 1' })
  const b = canvas({ id: 'b', title: '画面 2' })

  it('names the change and the card it was made on', () => {
    expect(labelOf([a, b], [a, { ...b, x: 30 }])).toBe('移动画面 2')
    expect(
      labelOf(
        [a, b],
        [
          { ...a, x: 1 },
          { ...b, y: 2 },
        ],
      ),
    ).toBe('移动 2 张卡片')
    expect(labelOf([a, b], [b])).toBe('删除画面 1')
    expect(labelOf([a, b], [])).toBe('删除 2 张卡片')
    expect(labelOf([a, run('r', 'a')], [a])).toBe('删除这次生成')
    expect(labelOf([a], [a, b])).toBe('新建画面 2')
    expect(labelOf([a], [a, picture('小猫')])).toBe('添加小猫')
    expect(labelOf([a], [{ ...a, prompt: '猫', summary: { ...a.summary, caption: '猫' } }])).toBe('改描述 · 画面 1')
    expect(labelOf([a], [{ ...a, layers: [layer()] }])).toBe('改区域 · 画面 1')
    expect(labelOf([a, picture('p')], [setLink(a, 'init', { canvasId: 'p' }), picture('p')])).toBe('连线 · 画面 1')
    const linked = setLink(a, 'init', { canvasId: 'p' })
    expect(labelOf([linked], [{ ...linked, inputs: undefined }])).toBe('删除连线 · 画面 1')
    expect(labelOf([a], [{ ...a, width: 768, height: 1344 }])).toBe('改大小 · 画面 1')
    expect(labelOf([a], [{ ...a, steps: 8, cfg: 1 }])).toBe('改设置 · 画面 1')
    expect(labelOf([run('r', 'a')], [run('r', 'a', { pinned: true, x: 4 })])).toBe('固定到画板')
  })

  it('uses the name it was given', () => {
    expect(labelOf([a], [{ ...a, prompt: 'x', steps: 8 }], '用这次的设置')).toBe('用这次的设置')
  })
})

describe('studio/history turns', () => {
  const steps = (): { history: BoardHistory; list: ProjectCanvas[] } => {
    const history = createHistory()
    let list = [canvas({ id: 'a' })]
    list = edit(history, list, [{ ...list[0]!, prompt: '猫' }], 'group:turn:1', { call: 'c1', label: '助手的修改' })
    list = edit(history, list, [{ ...list[0]!, layers: [layer()] }], 'group:turn:1', { call: 'c2' })
    return { history, list }
  }

  it('is one step, the latest, until another change lands on top', () => {
    const { history, list } = steps()
    expect(history.undo).toHaveLength(1)
    expect(stepLabel(history.undo[0]!)).toBe('助手的修改')
    expect(turnState(history, ['c1', 'c2'])).toBe('latest')
    expect(turnSteps(history, ['c1', 'c2'], 'undo')).toBe(1)
    expect(turnState(history, ['other'])).toBeNull()
    edit(history, list, [{ ...list[0]!, x: 9 }], 'tick:5')
    expect(turnState(history, ['c1', 'c2'])).toBe('buried')
    expect(turnSteps(history, ['c1', 'c2'], 'undo')).toBe(0)
  })

  it('offers redo right after its undo, and only then', () => {
    const { history } = steps()
    history.redo.push(history.undo.pop()!)
    expect(turnState(history, ['c2'])).toBe('redo')
    expect(turnSteps(history, ['c2'], 'redo')).toBe(1)
    // Something older undone after it: redoing the turn alone is not possible any more.
    const older = createHistory()
    edit(older, [canvas({ id: 'z' })], [canvas({ id: 'z', x: 1 })], 'tick:1')
    history.redo.push(older.undo[0]!)
    expect(turnState(history, ['c2'])).toBe('undone')
    expect(turnSteps(history, ['c2'], 'redo')).toBe(0)
  })
})
