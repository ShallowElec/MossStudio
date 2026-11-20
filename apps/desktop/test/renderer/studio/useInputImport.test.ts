import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Ipc } from '@shared/channels'
import type { ProjectCanvas } from '@shared/types'
import { createMockBackend } from '@test/mocks/backend'
import { useInputImport } from '@renderer/pages/studio/useInputImport'
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

/** The hook over an in-memory board, with the mock backend's file picker returning `picked`. */
function mount(start: ProjectCanvas[], picked: string[]) {
  const backend = createMockBackend('ready')
  backend.state.pickedImages = picked
  uninstall = backend.install()
  const board = { current: start }
  const notify = vi.fn()
  const project = {
    projectId: 'proj',
    sessionKey: 1,
    saveNow: async () => null,
    canvasesRef: board,
    setCanvases: (next: ProjectCanvas[] | ((previous: ProjectCanvas[]) => ProjectCanvas[])) => {
      board.current = typeof next === 'function' ? next(board.current) : next
    },
  }
  let api: ReturnType<typeof useInputImport> | null = null
  function Probe({ session }: { session: number }): null {
    api = useInputImport({ project: { ...project, sessionKey: session }, notify })
    return null
  }
  root = createRoot(document.createElement('div'))
  act(() => root!.render(createElement(Probe, { session: 1 })))
  let session = 1
  /** Another project opened: the page renders the hook with a new session. */
  const switchProject = (): void => {
    session += 1
    act(() => root!.render(createElement(Probe, { session })))
  }
  return { api: () => api!, board, backend, notify, switchProject }
}

describe('studio/useInputImport', () => {
  it('a cancelled pick makes no canvas and changes nothing', async () => {
    const { api, board, backend } = mount([canvas()], [])
    const make = vi.fn(() => 'new')
    expect(await api().addFromFile(make, 'init')).toBeNull()
    expect(backend.callsTo(Ipc.pickImages)).toHaveLength(1)
    expect(make).not.toHaveBeenCalled()
    expect(board.current).toEqual([canvas()])
  })

  it('makes the canvas once a picture is chosen and feeds it as 起始图, in the picture’s shape', async () => {
    const { api, board } = mount([], ['/home/me/photo-1024x768.png'])
    const make = vi.fn(() => {
      board.current = [...board.current, canvas({ id: 'made' })]
      return 'made'
    })
    expect(await api().addFromFile(make, 'init')).toBe('made')
    expect(make).toHaveBeenCalledTimes(1)
    const image = board.current.find((card) => card.kind === 'image')!
    expect(image.imageSize).toEqual({ width: 1024, height: 768 })
    const made = board.current.find((card) => card.id === 'made')!
    expect(made.inputs?.init?.link).toEqual({ canvasId: image.id })
    expect(made).toMatchObject({ width: 1152, height: 864 })
  })

  it('a pick that comes back after another project was opened changes nothing', async () => {
    const { api, board, backend, switchProject } = mount([canvas()], ['/home/me/photo-1024x768.png'])
    const held = backend.hold(Ipc.pickImages)
    const make = vi.fn(() => 'new')
    const pending = api().addFromFile(make, 'init')
    await held.called
    switchProject()
    await held.release()
    expect(await pending).toBeNull()
    expect(make).not.toHaveBeenCalled()
    expect(backend.callsTo(Ipc.studioImportImage)).toHaveLength(0)
    expect(board.current).toEqual([canvas()])
    // A slot's own canvas id is not linked into either: nothing is imported.
    const again = backend.hold(Ipc.pickImages)
    const slot = api().addFromFile('c1', 'init')
    await again.called
    switchProject()
    await again.release()
    expect(await slot).toBeNull()
    expect(backend.callsTo(Ipc.studioImportImage)).toHaveLength(0)
  })

  it('says a single-picture slot takes only the first of several files', async () => {
    const { api, board, notify } = mount([canvas()], ['/home/me/a.png', '/home/me/b.png'])
    expect(await api().addFromFile('c1', 'init')).toBe('c1')
    expect(notify).toHaveBeenCalledWith('起始图只能放一张，放入了第一张', 'info')
    expect(board.current.filter((card) => card.kind === 'image')).toHaveLength(1)
  })
})
