import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CanvasAdapter, ProjectCanvas } from '@shared/types'
import { adaptersWithStyles } from '@renderer/pages/studio/nodes'
import { deriveReadiness } from '@renderer/pages/studio/readiness'
import { createMockBackend } from '@test/mocks/backend'
import { ToastProvider } from '@renderer/components/ui'
import { LoraProfileHint, LoraTriggerBar, toggleTriggerInDescription } from '@renderer/components/studio/LoraTriggerBar'
import {
  createLoraProfileStore,
  createLoraProfilesClient,
  normalizeLoraProfiles,
  parseTriggerText,
  recommendedStrength,
  type LoraProfile,
  type LoraProfileStore,
} from '@renderer/components/studio/loraProfilesClient'
import { addTrigger, applyLoraAutoTriggers, compileCanvasPrompt, promptHasTrigger, removeTrigger } from '@renderer/pages/studio/prompt'
import { canvas, layer } from './fixtures'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let root: Root | undefined
let element: HTMLDivElement | undefined
afterEach(() => {
  act(() => root?.unmount())
  element?.remove()
  root = undefined
})

describe('trigger words in the description', () => {
  it('finds whole phrases in any case, not fragments of other words', () => {
    expect(promptHasTrigger('a girl, SKS style, garden', 'sks style')).toBe(true)
    expect(promptHasTrigger('a girl, sks   style', 'sks style')).toBe(true)
    expect(promptHasTrigger('many tasks', 'sks')).toBe(false)
    expect(promptHasTrigger('水彩风格的少女', '水彩风格')).toBe(true)
    expect(promptHasTrigger('(masterpiece:1.2), girl', '(masterpiece:1.2)')).toBe(true)
  })

  it('appends with an English comma and never twice', () => {
    expect(addTrigger('', 'sks')).toBe('sks')
    expect(addTrigger('a girl', 'sks')).toBe('a girl, sks')
    expect(addTrigger('a girl,  ', 'sks')).toBe('a girl, sks')
    expect(addTrigger('灯塔下的港口，', 'sks')).toBe('灯塔下的港口，sks')
    expect(addTrigger('a girl, SKS', 'sks')).toBe('a girl, SKS')
    expect(addTrigger('a girl', 'sks', 'prefix')).toBe('sks, a girl')
  })

  it('removes the trigger and the separator it leaves, keeping other lines as written', () => {
    expect(removeTrigger('a girl, sks, garden', 'sks')).toBe('a girl, garden')
    expect(removeTrigger('sks, a girl', 'sks')).toBe('a girl')
    expect(removeTrigger('a girl, sks', 'SKS')).toBe('a girl')
    expect(removeTrigger('a sks girl', 'sks')).toBe('a girl')
    expect(removeTrigger('tasks, sks', 'sks')).toBe('tasks')
    expect(removeTrigger('line one,\nsks, line two', 'sks')).toBe('line one,\nline two')
  })

  it('toggles: a present word is taken out, a missing one is added', () => {
    expect(toggleTriggerInDescription('a girl, sks', 'sks')).toBe('a girl')
    expect(toggleTriggerInDescription('a girl', 'sks')).toBe('a girl, sks')
  })

  it('parses typed trigger lists with either comma width and drops duplicates', () => {
    expect(parseTriggerText('sks, watercolor，SKS\n  ink ;')).toEqual(['sks', 'watercolor', 'ink'])
  })
})

describe('applyLoraAutoTriggers', () => {
  const profiles: Record<string, LoraProfile> = {
    ink: { loraId: 'ink', triggers: ['ink style', 'lineart'], autoInsert: 'prefix' },
    wash: { loraId: 'wash', triggers: ['watercolor', 'lineart'], autoInsert: 'suffix' },
    manual: { loraId: 'manual', triggers: ['manual word'], autoInsert: 'manual' },
    'styles/remote.safetensors': { loraId: 'styles/remote.safetensors', triggers: ['remote'], autoInsert: 'suffix' },
  }

  it('puts prefix words first and suffix words last, in adapter order, each once', () => {
    const adapters: CanvasAdapter[] = [
      { id: 'ink', strength: 1 },
      { id: 'wash', strength: 1 },
      { id: 'manual', strength: 1 },
    ]
    expect(applyLoraAutoTriggers('a harbor,', adapters, profiles)).toBe('ink style, lineart, a harbor, watercolor')
  })

  it('skips words already written and leaves the prompt alone when nothing is missing', () => {
    expect(applyLoraAutoTriggers('Ink Style, lineart, harbor', [{ id: 'ink', strength: 1 }], profiles)).toBe('Ink Style, lineart, harbor')
    expect(applyLoraAutoTriggers('harbor', [{ id: 'manual', strength: 1 }], profiles)).toBe('harbor')
    expect(applyLoraAutoTriggers('harbor', [], profiles)).toBe('harbor')
  })

  it('looks remote LoRAs up by their relative file name', () => {
    expect(applyLoraAutoTriggers('harbor', [{ id: 'remote-1a2b', path: 'styles/remote.safetensors', strength: 1 }], profiles)).toBe(
      'harbor, remote',
    )
  })

  it('is what compileCanvasPrompt sends with the profiles it is given, for plain and layout canvases, never for an empty description', () => {
    const plain = canvas({ prompt: 'harbor', adapters: [{ id: 'wash', strength: 0.8 }] })
    expect(compileCanvasPrompt(plain, profiles).prompt).toBe('harbor, watercolor, lineart')
    expect(compileCanvasPrompt(plain).prompt).toBe('harbor')
    expect(compileCanvasPrompt(canvas({ prompt: '  ', adapters: [{ id: 'wash', strength: 1 }] }), profiles).ok).toBe(false)
    const layout = canvas({
      summary: { caption: 'harbor', meta: [], canvas: 'single' },
      layers: [layer()],
      adapters: [{ id: 'ink', strength: 1 }],
    })
    const compiled = compileCanvasPrompt(layout, profiles)
    expect(compiled.ok).toBe(true)
    expect(compiled.prompt).toContain('ink style, lineart, harbor')
  })

  it('adds the trigger words of a LoRA that comes from a 风格, in the prompt readiness shows', () => {
    const style = canvas({ id: 'st', kind: 'style', prompt: '', adapters: [{ id: 'wash', strength: 1 }] })
    const own = canvas({ id: 'a', prompt: 'harbor', inputs: { styles: { links: [{ canvasId: 'st' }] } } } as Partial<ProjectCanvas>)
    expect(adaptersWithStyles(own, [own, style]).map((adapter) => adapter.id)).toEqual(['wash'])
    const readiness = deriveReadiness({
      catalog: null,
      bundle: { bundle: null, installed: false, unavailable: false },
      canvas: own,
      engine: null,
      setupDone: true,
      remote: null,
      loraProfiles: profiles,
      promptAdapters: adaptersWithStyles(own, [own, style]),
    })
    expect(readiness.prompt?.prompt).toBe('harbor, watercolor, lineart')
  })
})

describe('lora-profiles client', () => {
  it('accepts both list shapes and cleans every field', () => {
    const raw = {
      ink: { triggers: [' ink ', 'INK', 3, ''], suggestedTriggers: ['ink', 'brush'], defaultStrength: 0.756, autoInsert: 'prefix' },
      bad: { loraId: 'bad', triggers: [], defaultStrength: 5, autoInsert: 'sideways' },
    }
    const direct = normalizeLoraProfiles(raw)
    expect(direct.ink).toEqual({
      loraId: 'ink',
      triggers: ['ink'],
      suggestedTriggers: ['brush'],
      defaultStrength: 0.76,
      autoInsert: 'prefix',
    })
    expect(direct.bad).toEqual({ loraId: 'bad', triggers: [] })
    expect(normalizeLoraProfiles({ profiles: raw })).toEqual(direct)
    expect(normalizeLoraProfiles(null)).toEqual({})
  })

  it('starts a picked LoRA at its recommended strength, else at 1', () => {
    expect(recommendedStrength({ ink: { loraId: 'ink', triggers: [], defaultStrength: 0.6 } }, 'ink')).toBe(0.6)
    expect(recommendedStrength({}, 'ink')).toBe(1)
  })

  it('degrades to no profiles and no inspection when this build has no handler', async () => {
    const backend = createMockBackend('ready')
    backend.install()
    for (const channel of ['lora-profiles:list', 'lora-profiles:save', 'lora-profiles:inspect'])
      backend.fail(channel, { code: 'E_MOCK_UNHANDLED', message: `mock backend has no handler for ${channel}` })
    const client = createLoraProfilesClient()
    expect(await client.list()).toEqual({})
    expect(await client.inspect({ loraId: 'ink' })).toBeNull()
    await expect(client.save({ loraId: 'ink', triggers: ['ink'] })).rejects.toThrow('还不能保存')
  })

  it('shares saved profiles with every reader and publishes them for compilation', async () => {
    const backend = createMockBackend('ready')
    backend.install()
    backend.handle('lora-profiles:list', () => ({ profiles: { ink: { loraId: 'ink', triggers: ['ink'] } } }))
    backend.handle('lora-profiles:save', (payload) => ({ ...(payload as object), updatedAt: '2026-11-20' }))
    const published: string[][] = []
    const store = createLoraProfileStore(createLoraProfilesClient(), (profiles) => published.push(Object.keys(profiles)))
    await store.load()
    await store.load()
    expect(backend.callsTo('lora-profiles:list')).toHaveLength(1)
    const saved = await store.save({ loraId: 'wash', triggers: ['watercolor'], autoInsert: 'suffix' })
    expect(saved).toMatchObject({ loraId: 'wash', triggers: ['watercolor'], autoInsert: 'suffix', updatedAt: '2026-11-20' })
    expect(Object.keys(store.getSnapshot())).toEqual(['ink', 'wash'])
    expect(published.at(-1)).toEqual(['ink', 'wash'])
  })
})

function mountBar(options: { profile: LoraProfile | undefined; description: string; store?: LoraProfileStore; adapter?: CanvasAdapter }) {
  const state = { description: options.description }
  function Host(): React.JSX.Element {
    const [description, setDescription] = useState(options.description)
    state.description = description
    return createElement(LoraTriggerBar, {
      adapter: options.adapter ?? { id: 'ink', strength: 1 },
      name: 'Ink',
      profile: options.profile,
      description,
      store: options.store,
      onDescriptionChange: (update: (value: string) => string) => setDescription((value) => update(value)),
    })
  }
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
  act(() => root!.render(createElement(ToastProvider, null, createElement(Host))))
  return { container: element, state }
}

async function click(target: Element | null) {
  await act(async () => (target as HTMLElement).click())
  for (let i = 0; i < 3; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

describe('LoraTriggerBar', () => {
  it('highlights words in the description and toggles them in and out with one click', async () => {
    const { container, state } = mountBar({
      profile: { loraId: 'ink', triggers: ['ink style', 'lineart'], autoInsert: 'suffix' },
      description: 'harbor, ink style',
    })
    const chip = (word: string) => container.querySelector(`[data-trigger-chip="${word}"]`)
    expect(chip('ink style')?.getAttribute('data-trigger-state')).toBe('in')
    expect(chip('ink style')?.getAttribute('aria-pressed')).toBe('true')
    expect(chip('lineart')?.getAttribute('data-trigger-state')).toBe('out')
    expect(container.querySelector('[data-trigger-auto]')?.textContent).toBe('自动后置')

    await click(chip('lineart'))
    expect(state.description).toBe('harbor, ink style, lineart')
    expect(chip('lineart')?.getAttribute('data-trigger-state')).toBe('in')
    await click(chip('lineart'))
    expect(state.description).toBe('harbor, ink style')
    await click(chip('ink style'))
    expect(state.description).toBe('harbor')
  })

  it('adopts a suggested word: writes it and saves it as a trigger', async () => {
    const backend = createMockBackend('ready')
    backend.install()
    backend.handle('lora-profiles:save', (payload) => payload)
    const store = createLoraProfileStore(createLoraProfilesClient())
    const { container, state } = mountBar({
      profile: { loraId: 'ink', triggers: ['ink style'], suggestedTriggers: ['brush'], defaultStrength: 0.7 },
      description: 'harbor',
      store,
    })
    const suggested = container.querySelector('[data-trigger-chip="brush"]')
    expect(suggested?.getAttribute('data-trigger-state')).toBe('suggested')
    await click(suggested)
    expect(state.description).toBe('harbor, brush')
    expect(backend.callsTo('lora-profiles:save')).toEqual([{ loraId: 'ink', triggers: ['ink style', 'brush'], defaultStrength: 0.7 }])
    expect(store.getSnapshot().ink?.triggers).toEqual(['ink style', 'brush'])
  })

  it('edits triggers, strength and auto insertion, and re-reads the file header', async () => {
    const backend = createMockBackend('ready')
    backend.install()
    backend.handle('lora-profiles:inspect', () => ({
      loraId: 'styles/ink.safetensors',
      triggers: ['inkwash'],
      suggestedTriggers: ['brush'],
      source: 'ss_tag_frequency',
    }))
    backend.handle('lora-profiles:save', (payload) => payload)
    const store = createLoraProfileStore(createLoraProfilesClient())
    const { container } = mountBar({
      profile: undefined,
      description: 'harbor',
      store,
      adapter: { id: 'remote-1', path: 'styles/ink.safetensors', strength: 1 },
    })
    expect(container.textContent).toContain('没有触发词')
    await click(container.querySelector('[data-lora-trigger-edit]'))
    const dialog = document.body.querySelector('[data-lora-trigger-dialog]')!
    await click(dialog.querySelector('[data-lora-trigger-inspect]'))
    expect(backend.callsTo('lora-profiles:inspect')).toEqual([{ filePath: 'styles/ink.safetensors', loraId: 'styles/ink.safetensors' }])
    expect(dialog.querySelector('textarea')!.value).toBe('inkwash')
    await click(dialog.querySelector('[data-trigger-candidate="brush"]'))
    expect(dialog.querySelector('textarea')!.value).toBe('inkwash, brush')

    const strength = dialog.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(strength, '0.65')
      strength.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const prefix = Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent === '自动前置')!
    await click(prefix)
    const saveButton = document.body.querySelector('[data-lora-trigger-save]')
    await click(saveButton)
    expect(backend.callsTo('lora-profiles:save')).toEqual([
      { loraId: 'styles/ink.safetensors', triggers: ['inkwash', 'brush'], defaultStrength: 0.65, autoInsert: 'prefix' },
    ])
    expect(store.getSnapshot()['styles/ink.safetensors']?.autoInsert).toBe('prefix')
  })
})

describe('LoraProfileHint', () => {
  it('previews triggers, the recommended strength and the note inside a picker row', () => {
    element = document.createElement('div')
    root = createRoot(element)
    act(() =>
      root!.render(
        createElement(LoraProfileHint, {
          profile: { loraId: 'ink', triggers: ['a', 'b', 'c', 'd', 'e'], defaultStrength: 0.7, notes: '适合线稿' },
        }),
      ),
    )
    expect(element.textContent).toContain('+1')
    expect(element.textContent).toContain('推荐强度 0.7')
    expect(element.textContent).toContain('适合线稿')
  })
})
