import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { JobRecord, ProjectDocument, ProjectSummary } from '@shared/types'
import type { StudioClient, StudioProjectInput } from '@renderer/lib/studioClient'
import { useStudioProject, type StudioProject } from '@renderer/pages/studio/useStudioProject'
import { canvas } from './fixtures'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

function doc(id: string, patch: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    schemaVersion: 3,
    id,
    name: id,
    canvases: [canvas({ id: `${id}-c`, prompt: id, seedLocked: false })],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...patch,
  }
}

/** In-memory projects; `saveProject` can be made to fail or to wait. */
function fakeClient(initial: ProjectDocument[]) {
  const projects = new Map(initial.map((item) => [item.id, item]))
  const log: string[] = []
  let next = 1
  const control = { fail: false, hold: null as null | Promise<void> }
  const client: StudioClient = {
    listProjects: async () =>
      [...projects.values()].map((item): ProjectSummary => ({
        id: item.id,
        name: item.name,
        width: 1024,
        height: 1024,
        layerCount: 0,
        updatedAt: item.updatedAt,
      })),
    getProject: async (id) => projects.get(id) ?? null,
    saveProject: async (input: StudioProjectInput) => {
      log.push(`save:${input.id ?? 'new'}`)
      if (control.hold) await control.hold
      if (control.fail) throw new Error('disk full')
      const id = input.id && projects.has(input.id) ? input.id : `project-new-${next++}`
      const saved = doc(id, {
        name: input.name,
        canvases: input.canvases,
        selectedCanvasId: input.selectedCanvasId,
        updatedAt: `2026-11-02T00:00:${String(next++).padStart(2, '0')}.000Z`,
      })
      projects.set(id, saved)
      return saved
    },
    deleteProject: async (id) => {
      log.push(`delete:${id}`)
      projects.delete(id)
    },
    backendInfo: async () => ({ ready: true, url: 'http://x', token: 't' }),
  }
  return { client, projects, log, control }
}

const NO_JOBS: JobRecord[] = []
let root: Root | null = null

async function mount(
  client: StudioClient,
): Promise<{ get: () => StudioProject; errors: string[]; unmount: () => void; setJobs: (jobs: JobRecord[]) => Promise<void> }> {
  const errors: string[] = []
  let current: StudioProject | null = null
  function Probe({ jobs }: { jobs: JobRecord[] }): null {
    current = useStudioProject({ jobs, onError: (message) => errors.push(message), client })
    return null
  }
  root = createRoot(document.createElement('div'))
  await act(async () => {
    root!.render(createElement(Probe, { jobs: NO_JOBS }))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return {
    get: () => current!,
    errors,
    unmount: () => act(() => root!.unmount()),
    setJobs: async (jobs) => {
      await act(async () => {
        root!.render(createElement(Probe, { jobs }))
      })
    },
  }
}

/** Unmount and let the flush (which reads the file first) finish. */
async function unmountAndSettle(unmount: () => void): Promise<void> {
  unmount()
  root = null
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  vi.useRealTimers()
})

describe('useStudioProject', () => {
  it('opens the most recent project and migrates old seeds', async () => {
    const old = doc('a', { canvases: [canvas({ id: 'kept', seed: 1234 }), canvas({ id: 'default', seed: 42 })] })
    const { client } = fakeClient([old])
    const { get } = await mount(client)
    expect(get().projectId).toBe('a')
    expect(get().canvases.map((item) => [item.id, item.seedLocked])).toEqual([
      ['kept', true],
      ['default', false],
    ])
  })

  it('stays on the project, edits intact, when saving before a switch fails', async () => {
    const fake = fakeClient([doc('a'), doc('b')])
    const { get, errors } = await mount(fake.client)
    const openId = get().projectId!
    const otherId = openId === 'a' ? 'b' : 'a'
    await act(async () => {
      get().updateCanvas(`${openId}-c`, { prompt: 'unsaved edit' })
    })
    fake.control.fail = true
    await act(async () => {
      await get().openProject(otherId)
    })
    expect(get().projectId).toBe(openId)
    expect(get().canvases[0]!.prompt).toBe('unsaved edit')
    expect(errors.some((message) => message.includes('还没保存'))).toBe(true)

    await act(async () => {
      await get().newProject()
    })
    expect(get().projectId).toBe(openId)
    expect(get().canvases[0]!.prompt).toBe('unsaved edit')
  })

  it('switches after a successful save of pending edits', async () => {
    const fake = fakeClient([doc('a'), doc('b')])
    const { get } = await mount(fake.client)
    const openId = get().projectId!
    const otherId = openId === 'a' ? 'b' : 'a'
    await act(async () => {
      get().updateCanvas(`${openId}-c`, { prompt: 'kept' })
    })
    await act(async () => {
      await get().openProject(otherId)
    })
    expect(get().projectId).toBe(otherId)
    expect(fake.projects.get(openId)!.canvases[0]!.prompt).toBe('kept')
  })

  it('never writes a deleted project back, whether a save is pending, queued or in flight', async () => {
    const fake = fakeClient([doc('a')])
    const { get } = await mount(fake.client)
    // Only the autosave timer is faked; promises still resolve normally.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await act(async () => {
      get().updateCanvas('a-c', { prompt: 'edit 1' })
    })
    // One save in flight, one queued behind it, and the autosave timer pending.
    let release!: () => void
    fake.control.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    let deleting!: Promise<void>
    await act(async () => {
      void get().saveNow()
      // Let the first save reach the client, so it is truly in flight.
      for (let tick = 0; tick < 5 && !fake.log.includes('save:a'); tick += 1) await Promise.resolve()
      void get().saveNow()
      get().updateCanvas('a-c', { prompt: 'edit 2' })
      deleting = get().deleteProject('a')
    })
    fake.control.hold = null
    await act(async () => {
      release()
      await deleting
    })
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    expect(fake.log.filter((entry) => entry.startsWith('save:a'))).toEqual(['save:a'])
    expect(fake.log.indexOf('delete:a')).toBeGreaterThan(fake.log.indexOf('save:a'))
    expect(fake.projects.has('a')).toBe(false)
    expect([...fake.projects.keys()]).toEqual([])
    expect(get().projectId).toBeNull()
  })

  it('saves a pending edit when the Studio unmounts', async () => {
    const fake = fakeClient([doc('a')])
    const { get, unmount } = await mount(fake.client)
    await act(async () => {
      get().updateCanvas('a-c', { prompt: 'before leaving' })
    })
    await unmountAndSettle(unmount)
    expect(fake.projects.get('a')!.canvases[0]!.prompt).toBe('before leaving')
  })

  it('does not write on unmount when only job progress changed the canvases', async () => {
    const fake = fakeClient([
      doc('a', { canvases: [canvas({ id: 'a-c', prompt: 'a', jobId: 'j1', jobState: 'running', seedLocked: false })] }),
    ])
    const { get, unmount, setJobs } = await mount(fake.client)
    await setJobs([{ id: 'j1', state: 'canceled' } as JobRecord])
    expect(get().canvases[0]!.jobState).toBe('canceled')
    await unmountAndSettle(unmount)
    expect(fake.log.filter((entry) => entry.startsWith('save'))).toEqual([])
  })

  it('never writes an older copy over a file that changed on disk since it was read', async () => {
    const fake = fakeClient([doc('a')])
    const { get, unmount } = await mount(fake.client)
    await act(async () => {
      get().updateCanvas('a-c', { prompt: 'local edit' })
    })
    // Someone else (another window, the LAN web UI, a test) writes the project.
    const newer = doc('a', {
      name: 'a',
      updatedAt: '2026-11-03T00:00:00.000Z',
      canvases: [canvas({ id: 'a-c', prompt: 'written elsewhere' }), canvas({ id: 'extra' })],
    })
    fake.projects.set('a', newer)
    await unmountAndSettle(unmount)
    expect(fake.log.filter((entry) => entry.startsWith('save'))).toEqual([])
    expect(fake.projects.get('a')).toBe(newer)
  })
})

describe('useStudioProject history', () => {
  /** Let the task end, so the next edit is a new moment. */
  const nextTask = (): Promise<void> => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  const two = (): ProjectDocument =>
    doc('a', { canvases: [canvas({ id: 'a-c', title: '画面 1' }), canvas({ id: 'b-c', title: '画面 2', x: 400 })] })

  it('makes the edits of one moment one step, and undo and redo walk the steps', async () => {
    const { get } = await mount(fakeClient([two()]).client)
    expect([get().history.canUndo, get().history.canRedo]).toEqual([false, false])
    await act(async () => {
      // A group of cards let go together.
      get().updateCanvas('a-c', { x: 50 })
      get().updateCanvas('b-c', { x: 450 })
    })
    await nextTask()
    await act(async () => get().updateCanvas('a-c', { prompt: '一只猫' }))
    expect(get().history.canUndo).toBe(true)

    let label: string | null = null
    await act(async () => {
      label = get().history.undo()
    })
    expect(label).toBe('改描述 · 画面 1')
    expect(get().canvases[0]!.prompt).toBe('')
    await act(async () => {
      label = get().history.undo()
    })
    expect(label).toBe('移动 2 张卡片')
    expect(get().canvases.map((item) => item.x)).toEqual([0, 400])
    expect([get().history.canUndo, get().history.canRedo]).toEqual([false, true])
    await act(async () => {
      label = get().history.redo()
    })
    expect(label).toBe('移动 2 张卡片')
    expect(get().canvases.map((item) => item.x)).toEqual([50, 450])
  })

  it('typing in a field is one step for as long as the field keeps focus', async () => {
    const { get } = await mount(fakeClient([two()]).client)
    const field = document.body.appendChild(document.createElement('textarea'))
    const button = document.body.appendChild(document.createElement('button'))
    try {
      field.focus()
      for (const text of ['一', '一只', '一只猫']) {
        await act(async () => get().updateCanvas('a-c', { prompt: text }))
        await nextTask()
      }
      button.focus()
      field.focus()
      await act(async () => get().updateCanvas('a-c', { prompt: '一只猫，坐着' }))
      button.focus()
      await act(async () => {
        get().history.undo()
      })
      expect(get().canvases[0]!.prompt).toBe('一只猫')
      await act(async () => {
        get().history.undo()
      })
      expect(get().canvases[0]!.prompt).toBe('')
      expect(get().history.canUndo).toBe(false)
    } finally {
      field.remove()
      button.remove()
    }
  })

  it('a box dragged with the pointer held is one step, however many moves it takes', async () => {
    const { get } = await mount(fakeClient([two()]).client)
    window.dispatchEvent(new Event('pointerdown'))
    for (const x of [10, 20, 30, 40]) {
      await act(async () =>
        get().updateCanvas('a-c', {
          layers: [{ id: 'r', kind: 'object', caption: '', bbox: [x, 0, x + 100, 100], visible: true, locked: false, opacity: 1 }],
        }),
      )
      await nextTask()
    }
    window.dispatchEvent(new Event('pointerup'))
    await act(async () => {
      get().history.undo()
    })
    expect(get().canvases[0]!.layers).toEqual([])
    expect(get().history.canUndo).toBe(false)
  })

  it("keeps a run's own writes and a job finishing out of the steps", async () => {
    const result = canvas({ id: 'r', title: '结果', kind: 'result', sourceCanvasId: 'a-c', pinned: true, jobId: 'j1', jobState: 'running' })
    const { get, setJobs } = await mount(fakeClient([doc('a', { canvases: [canvas({ id: 'a-c' }), result] })]).client)
    await act(async () => get().updateCanvas('r', { x: 300 }))
    await nextTask()
    // A run starting writes the seed and its job id: not a step.
    await act(async () => get().setRunCanvases((list) => list.map((item) => (item.id === 'a-c' ? { ...item, seed: 99 } : item))))
    await setJobs([{ id: 'j1', state: 'succeeded', outputs: [{ path: '/out/r.png', width: 1024, height: 1024, seed: 1 }] } as JobRecord])
    let label: string | null = null
    await act(async () => {
      label = get().history.undo()
    })
    expect(label).toBe('移动结果')
    const after = get().canvases.find((item) => item.id === 'r')!
    expect(after.x).toBe(0)
    expect(after.jobState).toBe('succeeded')
    expect(after.outputs).toHaveLength(1)
    expect(get().canvases[0]!.seed).toBe(99)
    expect(get().history.canUndo).toBe(false)
  })

  it('brings a deleted card back selected, with the run it took along', async () => {
    const fake = fakeClient([
      doc('a', {
        canvases: [
          canvas({ id: 'a-c' }),
          canvas({ id: 'b-c', title: '画面 2' }),
          canvas({ id: 'run', kind: 'result', sourceCanvasId: 'b-c', outputs: [{ path: '/out/1.png', width: 1, height: 1, seed: 1 }] }),
        ],
        selectedCanvasId: 'a-c',
      }),
    ])
    const { get } = await mount(fake.client)
    await act(async () => {
      get().removeCanvas('b-c')
    })
    expect(get().canvases.map((item) => item.id)).toEqual(['a-c'])
    await act(async () => {
      get().history.undo()
    })
    expect(get().canvases.map((item) => item.id)).toEqual(['a-c', 'b-c', 'run'])
    expect(get().canvases[2]!.outputs?.[0]?.path).toBe('/out/1.png')
    expect(get().selectedCanvasId).toBe('b-c')
  })

  it('groups an assistant turn across tasks and names it 助手的修改', async () => {
    const { get } = await mount(fakeClient([two()]).client)
    const turn = { key: 'turn:1', label: '助手的修改' }
    await act(async () => get().history.within({ ...turn, call: 'c1' }, () => get().updateCanvas('a-c', { prompt: '猫' })))
    await nextTask()
    await act(async () => get().history.within({ ...turn, call: 'c2' }, () => get().updateCanvas('b-c', { prompt: '狗' })))
    expect(get().history.turn(['c1', 'c2'])).toBe('latest')
    let label: string | null = null
    await act(async () => {
      label = get().history.undoTurn(['c1', 'c2'])
    })
    expect(label).toBe('助手的修改')
    expect(get().canvases.map((item) => item.prompt)).toEqual(['', ''])
    expect(get().history.turn(['c1', 'c2'])).toBe('redo')
    await act(async () => {
      get().history.redoTurn(['c1', 'c2'])
    })
    expect(get().canvases.map((item) => item.prompt)).toEqual(['猫', '狗'])
  })

  it('starts empty in every project it opens', async () => {
    const { get } = await mount(fakeClient([doc('a'), doc('b')]).client)
    const openId = get().projectId!
    await act(async () => get().updateCanvas(`${openId}-c`, { x: 77 }))
    expect(get().history.canUndo).toBe(true)
    await act(async () => {
      await get().openProject(openId === 'a' ? 'b' : 'a')
    })
    expect([get().history.canUndo, get().history.canRedo]).toEqual([false, false])
  })
})
