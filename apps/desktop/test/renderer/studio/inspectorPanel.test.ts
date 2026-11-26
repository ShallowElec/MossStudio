import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ProjectLayer } from '@shared/types'
import { loadStore } from '../../helpers/renderer'
import { canvas, layer } from './fixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.setConfig({ testTimeout: 30_000 })

let InspectorPanelComponent: typeof import('@renderer/pages/studio/InspectorPanel').InspectorPanel
let ParamsPanelComponent: typeof import('@renderer/pages/studio/ParamsPanel').ParamsPanel
let ToastProviderComponent: typeof import('@renderer/components/ui').ToastProvider

beforeAll(async () => {
  InspectorPanelComponent = (await import('@renderer/pages/studio/InspectorPanel')).InspectorPanel
  ParamsPanelComponent = (await import('@renderer/pages/studio/ParamsPanel')).ParamsPanel
  ToastProviderComponent = (await import('@renderer/components/ui')).ToastProvider
}, 60_000)

let root: Root | null = null
let container: HTMLElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('Studio region panel layout stability', () => {
  it('renders 物体/人物/文字 in a full-width Segmented control inside min-w-0 containers and toggles the text input', async () => {
    function Harness(): React.JSX.Element {
      const [layers, setLayers] = useState<ProjectLayer[]>([layer({ id: 'r1', kind: 'object' })])
      return createElement(InspectorPanelComponent, {
        canvas: canvas({ layers }),
        selectedRegionId: 'r1',
        onSelectRegion: () => undefined,
        onChangeLayers: (update) => setLayers((current) => update(current)),
      })
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(Harness))
    })

    const group = container.querySelector('[role="group"][aria-label="区域类型"]')
    expect(group).not.toBeNull()
    expect(group!.className).toContain('w-full')
    expect(group!.closest('section')?.className).toContain('min-w-0')
    expect(group!.closest('section')?.parentElement?.className).toContain('min-w-0')

    const buttons = [...group!.querySelectorAll('button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['物体', '人物', '文字'])
    for (const button of buttons) expect(button.className).toContain('flex-1')

    expect(container.querySelector('input[aria-label="要显示的文字"]')).toBeNull()

    await act(async () => {
      buttons[1]!.click()
    })
    expect(container.querySelector('input[aria-label="要显示的文字"]')).toBeNull()

    await act(async () => {
      buttons[2]!.click()
    })
    expect(container.querySelector('input[aria-label="要显示的文字"]')).not.toBeNull()
  })

  it('gives ParamsPanel scrollable panels a stable scrollbar gutter', async () => {
    await loadStore('ready')

    const canvases = [
      canvas({ layers: [layer({ id: 'r1', kind: 'object' })] }),
      canvas({ id: 's1', kind: 'style', title: '风格 1', layers: [] }),
    ]

    for (const currentCanvas of canvases) {
      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
      await act(async () => {
        root!.render(
          createElement(
            ToastProviderComponent,
            null,
            createElement(ParamsPanelComponent, {
              canvas: currentCanvas,
              regionCount: currentCanvas.layers.length,
              catalog: null,
              bundle: { bundle: null, installed: false, unavailable: false },
              settings: null,
              gpuInventory: null,
              hosts: [],
              remoteHostId: '',
              onRemoteHostChange: () => undefined,
              blockers: [],
              prompt: null,
              blocked: false,
              going: false,
              queued: 0,
              full: false,
              onChange: () => undefined,
              onPickBundle: () => undefined,
              onOpenAdapters: () => undefined,
              onGenerate: () => undefined,
              onCopyAsLayout: () => undefined,
              onAddCanvas: () => undefined,
              onNavigate: () => undefined,
            }),
          ),
        )
      })

      const scroll = container.querySelector('.studio-scroll.overflow-x-hidden.overflow-y-auto')
      expect(scroll).not.toBeNull()
      expect(scroll!.className).toContain('pr-3.5')
      act(() => root?.unmount())
      container.remove()
      root = null
      container = null
    }
  })
})
