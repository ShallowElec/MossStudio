import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Ipc } from '@shared/channels'
import { aiProviderFixture } from '@test/mocks/backend'
import { flush, loadStore } from '../../helpers/renderer'

// The first import of the component tree loads the Markdown renderer behind components/ui (about 3 s
// cold, several times that on a loaded runner). Load it once here so the tests' own 5 s cover only their work.
beforeAll(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  await import('@renderer/components/common/ProviderDialog')
}, 60_000)

let root: Root | null = null
let container: HTMLElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

type Gate = ReturnType<typeof import('@renderer/components/common/ProviderDialog').useModelGate>

async function mountGate(): Promise<() => Gate> {
  const { useModelGate } = await import('@renderer/components/common/ProviderDialog')
  const { ToastProvider } = await import('@renderer/components/ui')
  let gate: Gate
  function Probe(): React.JSX.Element {
    gate = useModelGate()
    return gate.dialog
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(ToastProvider, null, createElement(Probe))))
  return () => gate
}

const dialogTitle = (): string | null => document.querySelector('dialog h2')?.textContent ?? null

describe('hasModelFor', () => {
  it('needs any connection for text and one that sees pictures for 看图', async () => {
    const { hasModelFor } = await import('@renderer/components/common/ProviderDialog')
    const ollama = aiProviderFixture({ kind: 'ollama' })
    expect(hasModelFor({ action: '生成分镜' }, [])).toBe(false)
    expect(hasModelFor({ action: '生成分镜' }, [ollama])).toBe(true)
    expect(hasModelFor({ action: '解析', vision: true }, [ollama])).toBe(false)
    expect(hasModelFor({ action: '解析', vision: true }, [ollama, aiProviderFixture({ kind: 'anthropic' })])).toBe(true)
    expect(hasModelFor({ vision: true }, [aiProviderFixture({ noImageInput: true })])).toBe(false)
  })
})

describe('useModelGate', () => {
  it('runs at once with the connections as they are now when a suitable one is connected', async () => {
    const { backend } = await loadStore('ready')
    const claude = aiProviderFixture({ id: 'claude', kind: 'anthropic' })
    backend.state.aiProviders = [claude]
    const gate = await mountGate()
    const run = vi.fn()
    await act(async () => gate().require({ action: '解析', vision: true }, run))
    expect(run).toHaveBeenCalledWith(undefined, [claude])
    expect(dialogTitle()).toBeNull()
  })

  it('asks for a model, titled after the action, and runs nothing until one is connected', async () => {
    const { backend } = await loadStore('ready')
    backend.state.aiProviders = [aiProviderFixture({ kind: 'ollama' })]
    const gate = await mountGate()
    const run = vi.fn()
    await act(async () => gate().require({ action: '拆成区域', vision: true }, run))
    await act(() => flush())
    expect(dialogTitle()).toBe('拆成区域要用语言模型')
    expect(run).not.toHaveBeenCalled()
  })

  it('checks once for a double click, so one request goes out', async () => {
    const { backend } = await loadStore('ready')
    backend.state.aiProviders = [aiProviderFixture()]
    const gate = await mountGate()
    const held = backend.hold(Ipc.aiProvidersList)
    const run = vi.fn()
    let first: Promise<void> = Promise.resolve()
    await act(async () => {
      first = gate().require({ action: '生成分镜' }, run)
      await held.called
      await gate().require({ action: '生成分镜' }, run)
      await held.release()
      await first
    })
    expect(run).toHaveBeenCalledTimes(1)
    // Once answered, the next click is checked again.
    await act(async () => gate().require({ action: '生成分镜' }, run))
    expect(run).toHaveBeenCalledTimes(2)
  })
})
