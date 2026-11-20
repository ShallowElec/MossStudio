import { describe, expect, it } from 'vitest'
import { AI_PROVIDER_PRESETS, languageProvider, presetsFor, seesPictures, visionProvider, type AiProviderInfo } from '@shared/ai'
import { schemas } from '@shared/schemas'

describe('AI_PROVIDER_PRESETS', () => {
  it('has unique names', () => {
    const names = AI_PROVIDER_PRESETS.map((preset) => preset.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('covers every provider kind', () => {
    expect(new Set(AI_PROVIDER_PRESETS.map((preset) => preset.kind))).toEqual(new Set(['openai', 'anthropic', 'gemini', 'ollama']))
  })

  it('can be saved as-is through the provider IPC schema', () => {
    for (const preset of AI_PROVIDER_PRESETS) {
      const parsed = schemas.aiProviderSave.safeParse(preset)
      expect(parsed.success, preset.name).toBe(true)
    }
  })

  it('uses http(s) base URLs without a trailing slash', () => {
    for (const preset of AI_PROVIDER_PRESETS) {
      expect(preset.baseUrl, preset.name).toMatch(/^https?:\/\/[^/]+/)
      expect(preset.baseUrl.endsWith('/'), preset.name).toBe(false)
    }
  })

  it('only uses plain http for the local Ollama endpoint', () => {
    for (const preset of AI_PROVIDER_PRESETS.filter((item) => item.baseUrl.startsWith('http://'))) {
      expect(preset.kind).toBe('ollama')
      expect(new URL(preset.baseUrl).hostname).toBe('127.0.0.1')
    }
  })

  it('names a model for every preset', () => {
    for (const preset of AI_PROVIDER_PRESETS) expect(preset.model.trim(), preset.name).not.toBe('')
  })
})

const connection = (id: string, patch: Partial<AiProviderInfo> = {}): AiProviderInfo => ({
  id,
  name: id,
  kind: 'openai',
  baseUrl: 'https://llm.test',
  model: 'm',
  temperature: 0.7,
  hasKey: true,
  ...patch,
})

describe('seesPictures', () => {
  it('takes an OpenAI-compatible or Anthropic model with a key, unless its provider said it takes no pictures', () => {
    expect(seesPictures({ kind: 'anthropic', hasKey: true })).toBe(true)
    expect(seesPictures({ kind: 'openai', hasKey: true })).toBe(true)
    expect(seesPictures({ kind: 'openai', hasKey: false })).toBe(false)
    expect(seesPictures({ kind: 'ollama', hasKey: true })).toBe(false)
    expect(seesPictures({ kind: 'gemini', hasKey: true })).toBe(false)
    expect(seesPictures({ kind: 'openai', hasKey: true, noImageInput: true })).toBe(false)
  })
})

describe('languageProvider', () => {
  it('is the chosen model, else the first connected, else none', () => {
    const list = [connection('a'), connection('b')]
    expect(languageProvider(list, 'b')?.id).toBe('b')
    expect(languageProvider(list, 'gone')?.id).toBe('a')
    expect(languageProvider(list, null)?.id).toBe('a')
    expect(languageProvider([], 'b')).toBeUndefined()
  })
})

describe('visionProvider', () => {
  it('is the chosen model while it sees pictures, else the first that does', () => {
    const list = [connection('local', { kind: 'ollama' }), connection('text', { noImageInput: true }), connection('a'), connection('b')]
    expect(visionProvider(list, 'b')?.id).toBe('b')
    expect(visionProvider(list, null)?.id).toBe('a')
    expect(visionProvider(list, 'text')?.id).toBe('a')
    expect(visionProvider(list, 'local')?.id).toBe('a')
    expect(visionProvider([connection('local', { kind: 'ollama' })], null)).toBeUndefined()
  })
})

describe('presetsFor', () => {
  it('offers 看图 only presets whose model sees pictures through KohakuGBC', () => {
    expect(presetsFor(true).map((preset) => preset.name)).toEqual(['OpenAI', 'Anthropic'])
    expect(presetsFor(false)).toEqual(AI_PROVIDER_PRESETS)
  })
})
