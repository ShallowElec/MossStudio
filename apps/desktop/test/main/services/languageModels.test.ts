import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTempDataRoot } from '@test/helpers/tempDir'

const root = useTempDataRoot()
const requests: string[] = []

beforeEach(async () => {
  vi.resetModules()
  // A real keyring, as on a desktop (the mock defaults to plain text on Linux), so keys can be saved.
  vi.spyOn((await import('electron')).safeStorage, 'getSelectedStorageBackend').mockReturnValue('gnome_libsecret')
  requests.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      requests.push(String(input))
      return Response.json({ choices: [{ message: { content: 'ok' } }] })
    }),
  )
})

const input = (name: string) => ({ name, kind: 'openai' as const, baseUrl: `https://${name}.test`, model: 'm', apiKey: 'k' })
const settingsFile = () => JSON.parse(readFileSync(join(root(), 'settings.json'), 'utf8')) as { languageProviderId?: string | null }
const writeSettings = (value: unknown) => writeFileSync(join(root(), 'settings.json'), JSON.stringify(value))

async function load() {
  const events = await import('@main/lib/events')
  const emitted: Array<[string, unknown]> = []
  events.onEmit((channel, payload) => emitted.push([channel, payload]))
  return { models: await import('@main/services/languageModels'), ai: await import('@main/services/ai'), emitted }
}

describe('connecting language models', () => {
  it('makes the first connection the 助手和漫画 model, and a later one does not take over', async () => {
    writeSettings({ languageProviderId: null })
    const { models } = await load()
    const first = models.connectProvider(input('first'))
    expect(settingsFile().languageProviderId).toBe(first.id)
    models.connectProvider(input('second'))
    expect(settingsFile().languageProviderId).toBe(first.id)
    expect(models.defaultLanguageProviderId()).toBe(first.id)
  })

  it('keeps the model in effect when nothing valid is chosen yet', async () => {
    writeSettings({ languageProviderId: 'gone' })
    const { models, ai } = await load()
    ai.saveProvider(input('older'))
    const inEffect = ai.saveProvider(input('newer'))
    models.connectProvider(input('newest'))
    expect(settingsFile().languageProviderId).toBe(inEffect.id)
  })

  it('tells every window that the list changed, without the list itself', async () => {
    writeSettings({ languageProviderId: null })
    const { models, ai, emitted } = await load()
    const saved = models.connectProvider(input('first'))
    ai.markNoImageInput(saved.id)
    models.disconnectProvider(saved.id)
    // The LAN relay forwards every event: names and addresses must not travel with it.
    expect(emitted.filter(([channel]) => channel === 'event:ai-providers')).toEqual([
      ['event:ai-providers', null],
      ['event:ai-providers', null],
      ['event:ai-providers', null],
    ])
  })

  it('sends a request that names no model to 助手和漫画, and one that does to that model', async () => {
    const { models, ai } = await load()
    const chosen = ai.saveProvider(input('chosen'))
    const other = ai.saveProvider(input('other'))
    writeSettings({ languageProviderId: chosen.id })
    await models.completeWithDefault({ system: 's', prompt: 'p' })
    await models.completeWithDefault({ providerId: other.id, system: 's', prompt: 'p' })
    expect(requests).toEqual(['https://chosen.test/chat/completions', 'https://other.test/chat/completions'])
  })
})
