import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Events, Ipc } from '@shared/channels'
import type { ModelSourcesView } from '@shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.setConfig({ testTimeout: 30_000 })

const listeners = new Map<string, Set<(data: unknown) => void>>()
const mocks = vi.hoisted(() => ({
  call: vi.fn(),
}))

vi.mock('@renderer/lib/api', () => ({
  call: (...args: unknown[]) => mocks.call(...args),
  onEvent: (channel: string, callback: (data: unknown) => void) => {
    let set = listeners.get(channel)
    if (!set) {
      set = new Set()
      listeners.set(channel, set)
    }
    set.add(callback)
    return () => {
      set?.delete(callback)
    }
  },
}))

function emit(channel: string, data: unknown): void {
  for (const listener of listeners.get(channel) ?? []) listener(data)
}

let ModelSourcesComponent: typeof import('@renderer/pages/models/ModelSources').ModelSources

beforeAll(async () => {
  ModelSourcesComponent = (await import('@renderer/pages/models/ModelSources')).ModelSources
}, 60_000)

let root: Root | null = null
let container: HTMLElement | null = null

const initialView: ModelSourcesView = {
  sources: [],
  suggestions: [],
}

const updatedView: ModelSourcesView = {
  sources: [
    {
      id: 'shared-1',
      kind: 'comfyui',
      path: 'C:\\ComfyUI\\models',
      roots: ['C:\\ComfyUI\\models'],
      available: 3,
      pending: 0,
      incompatible: 0,
      files: [],
      issues: [],
    },
  ],
  suggestions: [],
}

beforeEach(() => {
  listeners.clear()
  mocks.call.mockReset()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('ModelSources live refresh', () => {
  it('quietly refreshes when Events.modelsChanged arrives for shared-sources or settings and ignores unrelated reasons', async () => {
    const onSources = vi.fn()
    mocks.call.mockResolvedValueOnce(initialView).mockResolvedValueOnce(updatedView)

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(MemoryRouter, { initialEntries: ['/models'] }, createElement(ModelSourcesComponent, { onSources })))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(mocks.call).toHaveBeenCalledTimes(1)
    expect(mocks.call).toHaveBeenLastCalledWith(Ipc.modelSourcesList, undefined)
    expect(container.textContent).toContain('还没有接入模型目录')
    expect(onSources).toHaveBeenLastCalledWith([])

    // Unrelated catalog change events do not trigger a shared-source list fetch.
    await act(async () => {
      emit(Events.modelsChanged, { reason: 'download' })
      await Promise.resolve()
    })
    expect(mocks.call).toHaveBeenCalledTimes(1)

    // Background scan completion updates the sources list and notifies onSources without a loading spinner.
    await act(async () => {
      emit(Events.modelsChanged, { reason: 'shared-sources' })
      await Promise.resolve()
    })
    expect(mocks.call).toHaveBeenCalledTimes(2)
    expect(mocks.call).toHaveBeenLastCalledWith(Ipc.modelSourcesList)
    expect(container.textContent).toContain('C:\\ComfyUI\\models')
    expect(onSources).toHaveBeenLastCalledWith(updatedView.sources)

    // Settings updates (e.g. changing download folders) also refresh the list quietly.
    mocks.call.mockResolvedValueOnce(updatedView)
    await act(async () => {
      emit(Events.modelsChanged, { reason: 'settings' })
      await Promise.resolve()
    })
    expect(mocks.call).toHaveBeenCalledTimes(3)
    expect(mocks.call).toHaveBeenLastCalledWith(Ipc.modelSourcesList)
  })
})
