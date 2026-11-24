import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Ipc } from '@shared/channels'
import { aiProviderFixture } from '@test/mocks/backend'
import { flush, loadStore } from '../../helpers/renderer'

// The first import of the component tree loads the Markdown renderer behind components/ui (about 3 s
// cold, several times that on a loaded runner). Load it once here so the tests' own 5 s cover only their work.
beforeAll(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  await import('@renderer/pages/studio/assistant/Assistant')
}, 60_000)

let root: Root | null = null
let container: HTMLElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

const click = async (element: Element | null | undefined): Promise<void> => {
  if (!element) throw new Error('nothing to click')
  await act(async () => {
    ;(element as HTMLElement).click()
    await flush()
  })
}

describe('助手 model menu', () => {
  it('starts on 设置’s 助手和漫画 model, and picking another saves it there', async () => {
    const { backend, store } = await loadStore('ready')
    backend.state.aiProviders = [aiProviderFixture({ id: 'a', name: 'Alpha' }), aiProviderFixture({ id: 'b', name: 'Beta' })]
    backend.state.settings = { ...backend.state.settings, languageProviderId: 'b' }
    await act(async () => {
      await store().init()
    })
    const { Assistant } = await import('@renderer/pages/studio/assistant/Assistant')
    const { ToastProvider } = await import('@renderer/components/ui')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(ToastProvider, null, createElement(Assistant)))
      await flush()
    })
    const trigger = container.querySelector('button[aria-label="语言模型"]')
    expect(trigger?.textContent).toBe('Beta')

    await click(trigger)
    const alpha = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.startsWith('Alpha'))
    await click(alpha)
    expect(backend.callsTo(Ipc.settingsUpdate)).toEqual([{ languageProviderId: 'a' }])
    expect(container.querySelector('button[aria-label="语言模型"]')?.textContent).toBe('Alpha')
  })
})
