import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelSourcesView } from '@shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.setConfig({ testTimeout: 30_000 })

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
}))

vi.mock('@renderer/lib/api', () => ({
  call: (...args: unknown[]) => mocks.call(...args),
}))

let ModelSourcesComponent: typeof import('@renderer/pages/models/ModelSources').ModelSources

beforeAll(async () => {
  ModelSourcesComponent = (await import('@renderer/pages/models/ModelSources')).ModelSources
}, 60_000)

let root: Root | null = null
let container: HTMLElement | null = null

const sampleView: ModelSourcesView = {
  sources: [
    {
      id: 'comfy-1',
      kind: 'comfyui',
      path: 'C:\\ComfyUI\\models',
      roots: ['C:\\ComfyUI\\models'],
      available: 2,
      pending: 0,
      incompatible: 0,
      files: [],
      issues: ['已跳过配置中不存在的模型目录（来自 C:\\ComfyUI\\extra_model_paths.yaml）'],
      issueDetails: [
        {
          id: 'missing-config-dirs:extra',
          message: '已跳过配置中 2 个不存在的模型目录',
          origin: 'C:\\ComfyUI\\extra_model_paths.yaml',
          suggestion:
            '已像 ComfyUI 一样自动跳过，不影响读取当前目录里的其他模型；若这些旧路径已删除或迁移，可清理该配置文件，或点击「忽略」。',
          details: ['D:\\old-webui\\models\\Stable-diffusion', 'D:\\old-webui\\models\\VAE'],
        },
      ],
    },
  ],
  suggestions: [],
}

beforeEach(() => {
  localStorage.clear()
  mocks.call.mockReset()
  mocks.call.mockResolvedValue(sampleView)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

function LocationMarker(): React.JSX.Element {
  const { pathname } = useLocation()
  return createElement('div', { 'data-pathname': pathname })
}

async function renderSources(initialEntry = '/models'): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      createElement(
        MemoryRouter,
        { initialEntries: [initialEntry] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '*',
            element: createElement('div', null, createElement(LocationMarker), createElement(ModelSourcesComponent)),
          }),
        ),
      ),
    )
  })
  await act(async () => {
    await Promise.resolve()
  })
  return container
}

describe('ModelSources issue cards', () => {
  it('shows origin, suggestion and expandable paths, and lets the user dismiss and restore warnings', async () => {
    const view = await renderSources()
    expect(view.textContent).toContain('已跳过配置中 2 个不存在的模型目录')
    expect(view.textContent).toContain('来源：C:\\ComfyUI\\extra_model_paths.yaml')
    expect(view.textContent).toContain('建议：已像 ComfyUI 一样自动跳过')
    expect(view.textContent).not.toContain('D:\\old-webui\\models\\Stable-diffusion')

    const expandButton = [...view.querySelectorAll('button')].find((button) => button.textContent?.includes('查看涉及的 2 个目录'))
    expect(expandButton).toBeDefined()
    await act(async () => {
      expandButton!.click()
    })
    expect(view.textContent).toContain('D:\\old-webui\\models\\Stable-diffusion')
    expect(view.textContent).toContain('D:\\old-webui\\models\\VAE')

    const dismissButton = [...view.querySelectorAll('button')].find((button) => button.textContent === '忽略')
    expect(dismissButton).toBeDefined()
    await act(async () => {
      dismissButton!.click()
    })
    expect(view.querySelector('[data-source-issue]')).toBeNull()
    expect(view.textContent).toContain('已忽略 1 条提示')

    // Remounting keeps the dismissal from localStorage, and clicking 显示 brings it back.
    act(() => root?.unmount())
    container?.remove()
    const remounted = await renderSources()
    expect(remounted.querySelector('[data-source-issue]')).toBeNull()
    expect(remounted.textContent).toContain('已忽略 1 条提示')

    const restoreButton = [...remounted.querySelectorAll('button')].find((button) => button.textContent === '显示')
    expect(restoreButton).toBeDefined()
    await act(async () => {
      restoreButton!.click()
    })
    expect(remounted.querySelector('[data-source-issue]')).not.toBeNull()
    expect(remounted.textContent).toContain('来源：C:\\ComfyUI\\extra_model_paths.yaml')
  })

  it('offers a storage settings shortcut for overlap warnings on /models and omits it on /setup', async () => {
    const overlapView: ModelSourcesView = {
      sources: [
        {
          id: 'comfy-overlap',
          kind: 'comfyui',
          path: 'C:\\ComfyUI\\models',
          roots: [],
          available: 0,
          pending: 0,
          incompatible: 0,
          files: [],
          issues: ['已跳过与 Moss Studio 下载位置重叠的目录'],
          issueDetails: [
            {
              id: 'overlap:c:/comfyui/models',
              message: '已跳过与 Moss Studio 下载位置重叠的目录',
              origin: 'Moss Studio 下载位置：C:\\ComfyUI\\models',
              suggestion: '请到「设置 › 存储」将下载位置改为独立目录，再点击「自动扫描」。',
              details: ['C:\\ComfyUI\\models'],
            },
          ],
        },
      ],
      suggestions: [],
    }
    mocks.call.mockResolvedValue(overlapView)

    const setupView = await renderSources('/setup')
    expect([...setupView.querySelectorAll('button')].some((button) => button.textContent === '前往存储设置')).toBe(false)

    act(() => root?.unmount())
    container?.remove()

    const modelsView = await renderSources('/models')
    const storageButton = [...modelsView.querySelectorAll('button')].find((button) => button.textContent === '前往存储设置')
    expect(storageButton).toBeDefined()
    await act(async () => {
      storageButton!.click()
    })
    expect(modelsView.querySelector('[data-pathname]')?.getAttribute('data-pathname')).toBe('/settings/storage')
  })
})
