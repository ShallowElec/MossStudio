import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { diagnosticsReport } from '@renderer/pages/settings/diagnosticsReport'
import { useTempDataRoot } from '@test/helpers/tempDir'

type SafeStorage = (typeof import('@test/mocks/electron'))['safeStorage']

const root = useTempDataRoot()
const agentFile = () => join(root(), 'ai', 'agent.json')
const credentialsFile = () => join(root(), 'ai-credentials.json')
const agent = () => readFileSync(agentFile(), 'utf8')
const credentials = () => JSON.parse(readFileSync(credentialsFile(), 'utf8')) as Record<string, string>
let safeStorage: SafeStorage
let backend = 'gnome_libsecret'

/** A fresh process: modules reloaded, the keyring as `backend` says (the mock defaults to plain text on Linux). */
async function restart(): Promise<void> {
  vi.resetModules()
  safeStorage = (await import('electron')).safeStorage as SafeStorage
  vi.spyOn(safeStorage, 'getSelectedStorageBackend').mockImplementation(() => backend)
}

beforeEach(async () => {
  backend = 'gnome_libsecret'
  await restart()
})

const load = () => import('@main/services/ai')
const input = (apiKey?: string) => ({ name: 'Mine', kind: 'openai' as const, baseUrl: 'https://llm.example.test/v1', model: 'm', apiKey })

/** agent.json as an app before encryption wrote it: plain keys next to the rest. */
function writeLegacyAgent(): void {
  mkdirSync(join(root(), 'ai'), { recursive: true })
  writeFileSync(
    agentFile(),
    JSON.stringify({
      providers: [
        {
          id: 'provider-a',
          name: 'A',
          kind: 'openai',
          baseUrl: 'https://a.test/v1',
          model: 'm',
          temperature: 0.7,
          hasKey: true,
          apiKey: 'sk-plain-a',
        },
        {
          id: 'provider-b',
          name: 'B',
          kind: 'anthropic',
          baseUrl: 'https://b.test',
          model: 'm',
          temperature: 0.2,
          hasKey: true,
          apiKey: 'sk-plain-b',
        },
        {
          id: 'provider-c',
          name: 'C',
          kind: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          model: 'm',
          temperature: 0.7,
          hasKey: false,
          apiKey: '',
        },
      ],
      conversations: [
        { id: 'chat-1', title: 'Hi', providerId: 'provider-a', messages: [], createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      ],
    }),
  )
}

/** Every file under the data root, as text. */
function everyFile(dir = root()): string {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .map((path) => (statSync(path).isDirectory() ? everyFile(path) : readFileSync(path, 'utf8')))
    .join('\n')
}

describe('language model API keys', () => {
  it('are stored encrypted, never in agent.json, and read back for requests', async () => {
    const ai = await load()
    const saved = ai.saveProvider(input(' sk-round-trip '))
    expect(saved.hasKey).toBe(true)
    expect(agent()).not.toContain('sk-round-trip')
    expect(JSON.parse(agent()).providers[0]).not.toHaveProperty('apiKey')
    expect(readFileSync(credentialsFile(), 'utf8')).not.toContain('sk-round-trip')
    expect(ai.getProviderSecret(saved.id)?.apiKey).toBe('sk-round-trip')
  })

  it('keep the saved key when an edit leaves the field empty, and take a new one when typed', async () => {
    const ai = await load()
    const saved = ai.saveProvider(input('sk-first'))
    expect(ai.saveProvider({ ...input(''), id: saved.id, name: 'Renamed' })).toMatchObject({ name: 'Renamed', hasKey: true })
    expect(ai.getProviderSecret(saved.id)?.apiKey).toBe('sk-first')
    ai.saveProvider({ ...input('sk-second'), id: saved.id })
    expect(ai.getProviderSecret(saved.id)?.apiKey).toBe('sk-second')
    expect(agent()).not.toMatch(/sk-(first|second)/)
  })

  it('are deleted with their provider', async () => {
    const ai = await load()
    const kept = ai.saveProvider(input('sk-kept'))
    const removed = ai.saveProvider(input('sk-removed'))
    ai.removeProvider(removed.id)
    expect(Object.keys(credentials())).toEqual([kept.id])
    expect(ai.getProviderSecret(removed.id)).toBeNull()
    expect(ai.getProviderSecret(kept.id)?.apiKey).toBe('sk-kept')
  })

  it('are refused without secure storage, while a provider without a key still saves', async () => {
    backend = 'basic_text'
    vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false)
    const ai = await load()
    expect(() => ai.saveProvider(input('sk-nowhere'))).toThrow('系统安全存储不可用')
    expect(ai.listProviders()).toEqual([])
    expect(ai.saveProvider({ ...input(), kind: 'ollama' }).hasKey).toBe(false)
    expect(everyFile()).not.toContain('sk-nowhere')
  })
})

describe('plain API keys in agent.json (from before encryption)', () => {
  it('move into the encrypted store and leave agent.json, keeping everything else', async () => {
    writeLegacyAgent()
    const ai = await load()
    ai.migratePlainApiKeys()
    expect(agent()).not.toMatch(/sk-plain|apiKey/)
    expect(credentials()).toEqual({ 'provider-a': expect.any(String), 'provider-b': expect.any(String) })
    expect(ai.getProviderSecret('provider-a')?.apiKey).toBe('sk-plain-a')
    expect(ai.getProviderSecret('provider-b')?.apiKey).toBe('sk-plain-b')
    expect(ai.listProviders().map((provider) => [provider.id, provider.hasKey, provider.temperature])).toEqual([
      ['provider-a', true, 0.7],
      ['provider-b', true, 0.2],
      ['provider-c', false, 0.7],
    ])
    expect(ai.listConversations().map((conversation) => conversation.id)).toEqual(['chat-1'])
  })

  it('move once: a second start changes nothing', async () => {
    writeLegacyAgent()
    ;(await load()).migratePlainApiKeys()
    const [agentBefore, credentialsBefore] = [agent(), readFileSync(credentialsFile(), 'utf8')]
    await restart()
    const ai = await load()
    ai.migratePlainApiKeys()
    expect([agent(), readFileSync(credentialsFile(), 'utf8')]).toEqual([agentBefore, credentialsBefore])
    expect(ai.getProviderSecret('provider-a')?.apiKey).toBe('sk-plain-a')
  })

  it('survive a crash between the encrypted write and the agent.json cleanup', async () => {
    writeLegacyAgent()
    vi.doMock('@main/install/record', async (original) => {
      const actual = await original<typeof import('@main/install/record')>()
      return {
        ...actual,
        writeJsonAtomic: (file: string, value: unknown) => {
          if (file.endsWith('agent.json')) throw new Error('killed before the cleanup')
          actual.writeJsonAtomic(file, value)
        },
      }
    })
    await expect(load().then((ai) => ai.migratePlainApiKeys())).rejects.toThrow('killed before the cleanup')
    // Both copies exist; the plain one still works.
    expect(agent()).toContain('sk-plain-a')
    expect(Object.keys(credentials())).toEqual(['provider-a', 'provider-b'])
    vi.doUnmock('@main/install/record')
    await restart()
    const ai = await load()
    expect(ai.getProviderSecret('provider-a')?.apiKey).toBe('sk-plain-a')
    ai.migratePlainApiKeys()
    expect(agent()).not.toContain('sk-plain')
    expect(ai.getProviderSecret('provider-a')?.apiKey).toBe('sk-plain-a')
    expect(ai.getProviderSecret('provider-b')?.apiKey).toBe('sk-plain-b')
  })

  it('stay in agent.json when the encrypted copy does not read back', async () => {
    writeLegacyAgent()
    vi.spyOn(safeStorage, 'decryptString').mockReturnValue('something else')
    const ai = await load()
    expect(() => ai.migratePlainApiKeys()).toThrow('does not read back')
    expect(agent()).toContain('sk-plain-a')
    expect(agent()).toContain('sk-plain-b')
  })

  it('stay and keep working without secure storage, and move on a later start that has it', async () => {
    writeLegacyAgent()
    backend = 'basic_text'
    vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let ai = await load()
    ai.migratePlainApiKeys()
    expect(warn).toHaveBeenCalledWith('[ai] API keys stay in agent.json for now:', expect.stringContaining('系统安全存储不可用'))
    expect(ai.getProviderSecret('provider-a')?.apiKey).toBe('sk-plain-a')
    // Editing without retyping keeps the plain key; nothing reaches a window.
    const edited = ai.saveProvider({ id: 'provider-a', name: 'A2', kind: 'openai', baseUrl: 'https://a.test/v1', model: 'm' })
    expect(edited).toMatchObject({ name: 'A2', hasKey: true })
    expect(edited).not.toHaveProperty('apiKey')
    expect(ai.listProviders().every((provider) => !('apiKey' in provider))).toBe(true)
    expect(ai.getProviderSecret('provider-a')?.apiKey).toBe('sk-plain-a')
    // Removing a provider removes its plain key with it.
    ai.removeProvider('provider-b')
    expect(agent()).not.toContain('sk-plain-b')

    backend = 'gnome_libsecret'
    await restart()
    ai = await load()
    ai.migratePlainApiKeys()
    expect(agent()).not.toContain('sk-plain')
    expect(ai.getProviderSecret('provider-a')?.apiKey).toBe('sk-plain-a')
  })

  it('say the keyring may be locked when it cannot decrypt a key, and use a plain copy if there is one', async () => {
    writeLegacyAgent()
    const ai = await load()
    const saved = ai.saveProvider(input('sk-lost'))
    ai.saveProvider({ ...input('sk-encrypted-a'), id: 'provider-a' })
    // An older version, after a rollback, wrote a plain key again next to the encrypted one.
    const file = JSON.parse(agent()) as { providers: Array<{ id: string; apiKey?: string }> }
    file.providers.find((provider) => provider.id === 'provider-a')!.apiKey = 'sk-plain-a'
    writeFileSync(agentFile(), JSON.stringify(file))
    vi.spyOn(safeStorage, 'decryptString').mockImplementation(() => {
      throw new Error('keyring locked')
    })
    expect(() => ai.getProviderSecret(saved.id)).toThrow('系统钥匙串可能还没解锁')
    expect(ai.getProviderSecret('provider-a')?.apiKey).toBe('sk-plain-a')
  })

  it('drop temp files a killed write left behind, which may hold plain keys', async () => {
    writeLegacyAgent()
    const leftover = join(root(), 'ai', '.agent.json.1234.abcd.tmp')
    writeFileSync(leftover, readFileSync(agentFile()))
    ;(await load()).migratePlainApiKeys()
    expect(readdirSync(join(root(), 'ai'))).toEqual(['agent.json'])
    expect(everyFile()).not.toContain('sk-plain')
  })
})

describe('an unreadable ai-credentials.json', () => {
  it('is moved aside, not silently overwritten, when a key is saved', async () => {
    writeFileSync(credentialsFile(), '{"provider-old": "trunc')
    const ai = await load()
    const saved = ai.saveProvider(input('sk-after'))
    expect(ai.getProviderSecret(saved.id)?.apiKey).toBe('sk-after')
    const aside = readdirSync(root()).filter((name) => name.startsWith('ai-credentials.json.unreadable-'))
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(root(), aside[0]!), 'utf8')).toBe('{"provider-old": "trunc')
  })

  it('stops a save when it cannot be read at all, leaving it where it is', async () => {
    // A path that exists but cannot be read as a file, like one another program holds locked.
    mkdirSync(credentialsFile())
    const ai = await load()
    expect(() => ai.saveProvider(input('sk-blocked'))).toThrow(/EISDIR/)
    expect(statSync(credentialsFile()).isDirectory()).toBe(true)
    expect(readdirSync(root()).some((name) => name.includes('unreadable'))).toBe(false)
    expect(ai.listProviders()).toEqual([])
  })
})

describe('API keys never leave the main process', () => {
  it('reach no window, LAN relay, log, diagnostic or file other than the encrypted store', async () => {
    writeLegacyAgent()
    const events = await import('@main/lib/events')
    const emitted: unknown[] = []
    // The LAN backend relays exactly what onEmit sees (services/backend.ts).
    events.onEmit((channel, payload) => emitted.push([channel, payload]))
    const logged: unknown[] = []
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args))
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: { message: 'invalid request' } }, { status: 400 })),
    )
    const ai = await load()
    const models = await import('@main/services/languageModels')
    const settings = await import('@main/services/settings')
    const diagnostics = await import('@main/services/diagnostics')

    ai.migratePlainApiKeys()
    const returned: unknown[] = [models.connectProvider(input('sk-new-key'))]
    returned.push(models.connectProvider({ ...input(''), id: 'provider-a', name: 'A again' }))
    returned.push(ai.listProviders(), settings.getSettings())
    await expect(models.completeWithDefault({ providerId: 'provider-a', system: 's', prompt: 'p' })).rejects.toThrow('invalid request')
    // The 助手 streams to the window that asked (event.sender), not through onEmit.
    const streamed: unknown[] = []
    await expect(
      ai.chat(
        { providerId: 'provider-b', message: 'hi' },
        { emit: (event) => streamed.push(event), runTool: async () => ({ ok: true, content: '' }), tools: [] },
      ),
    ).rejects.toThrow()
    emitted.push(streamed)
    models.disconnectProvider('provider-b')
    const report = diagnosticsReport({
      info: null,
      env: null,
      gpu: null,
      engine: null,
      settings: settings.getSettings(),
      diagnostics: diagnostics.listDiagnostics(),
    })

    const keys = /sk-plain-a|sk-plain-b|sk-new-key/
    expect(JSON.stringify(returned)).not.toMatch(keys)
    expect(JSON.stringify(emitted)).not.toMatch(keys)
    expect(JSON.stringify(logged)).not.toMatch(keys)
    expect(report).not.toMatch(keys)
    expect(everyFile()).not.toMatch(keys)
    expect(ai.getProviderSecret('provider-a')?.apiKey).toBe('sk-plain-a')
  })
})
