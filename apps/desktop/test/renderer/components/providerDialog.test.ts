import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiProviderInfo } from '@shared/ai'
import { aiProviderFixture } from '@test/mocks/backend'
import { flush, loadStore } from '../../helpers/renderer'

let root: Root | null = null
let container: HTMLElement | null = null
afterEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

interface FirstFrame {
  name: string
  model: string
  confirm: string
}

describe('ProviderDialog', () => {
  it('shows the model being edited from the first frame it opens, so typing at once cannot wipe it', async () => {
    await loadStore('ready')
    const { ProviderDialog } = await import('@renderer/components/common/ProviderDialog')
    const { ToastProvider } = await import('@renderer/components/ui')
    const claude = aiProviderFixture({ id: 'claude', kind: 'anthropic', name: 'Claude', model: 'claude-sonnet' })
    const view = (editing: AiProviderInfo | null, open: boolean) =>
      createElement(ToastProvider, null, createElement(ProviderDialog, { open, editing, onClose: () => undefined }))

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(view(null, false)))

    // Render the opening the way a click lands in the app: committed first, effects after. Whatever
    // the first committed dialog shows is what a keystroke right then edits.
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
    const first = new Promise<FirstFrame>((resolve) => {
      const observer = new MutationObserver(() => {
        const dialog = document.querySelector('dialog')
        const inputs = dialog?.querySelectorAll('input')
        if (!dialog || !inputs?.length) return
        observer.disconnect()
        const buttons = [...dialog.querySelectorAll('footer button')]
        resolve({ name: inputs[0]!.value, model: inputs[2]!.value, confirm: buttons.at(-1)?.textContent ?? '' })
      })
      observer.observe(document.body, { childList: true, subtree: true })
    })
    root.render(view(claude, true))
    const frame = await first
    await flush()

    expect(frame).toEqual({ name: 'Claude', model: 'claude-sonnet', confirm: '保存修改' })
  })
})
