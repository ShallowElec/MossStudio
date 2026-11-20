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
  const project = {
    projectId: 'proj',
    saveNow: async () => null,
    canvasesRef: board,
    setCanvases: (next: ProjectCanvas[] | ((previous: ProjectCanvas[]) => ProjectCanvas[])) => {
      board.current = typeof next === 'function' ? next(board.current) : next
    },
  }
  let api: ReturnType<typeof useInputImport> | null = null
  function Probe(): null {
    api = useInputImport({ project, notify: () => undefined })
    return null
  }
  root = createRoot(document.createElement('div'))
  act(() => root!.render(createElement(Probe)))
  return { api: () => api!, board, backend }
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
})
