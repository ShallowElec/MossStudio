import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderKind } from '@shared/ai'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { pngBytes } from './pictures'

const root = useTempDataRoot()
let reply: (url: string, body: Record<string, unknown>) => Response
const requests: Array<{ url: string; body: Record<string, unknown> }> = []

beforeEach(() => {
  vi.resetModules()
  requests.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>
      requests.push({ url: String(input), body })
      return reply(String(input), body)
    }),
  )
})

/** A real keyring, as on a desktop (the mock defaults to plain text on Linux), so keys can be saved. */
async function useKeyring() {
  vi.spyOn((await import('electron')).safeStorage, 'getSelectedStorageBackend').mockReturnValue('gnome_libsecret')
}

async function setup(kind: AiProviderKind | null, trainingKind: 'person' | 'style' = 'person') {
  await useKeyring()
  const ai = await import('@main/services/ai')
  if (kind) ai.saveProvider({ name: kind, kind, baseUrl: 'https://llm.example.test', model: 'vision', apiKey: 'k' })
  const store = await import('@main/services/training/store')
  const project = await store.createTrainingProject({ kind: trainingKind, samples: true })
  if (trainingKind === 'person') await store.updateTrainingProject(project.id, { trigger: 'mira' })
  const images = join(root(), 'training', project.id, 'images')
  writeFileSync(join(images, 'a.png'), pngBytes(1024, 1024, 1))
  writeFileSync(join(images, 'b.png'), pngBytes(1024, 1024, 2))
  writeFileSync(join(images, 'b.txt'), 'mira, already described')
  return { captions: await import('@main/services/training/captions'), project, images }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('automatic descriptions', () => {
  it('asks only when a language model is connected', async () => {
    const { captions, project } = await setup(null)
    expect(await captions.autoCaption(project.id)).toEqual({ written: 0, failed: 0, error: captions.NO_PROVIDER })
    expect(requests).toHaveLength(0)
  })

  it('describes the pictures without a description through an OpenAI-compatible model, the trigger first', async () => {
    const { captions, project, images } = await setup('openai')
    reply = () => json({ choices: [{ message: { content: '"坐在窗边，柔和的光，半身"' } }] })
    expect(await captions.autoCaption(project.id)).toEqual({ written: 1, failed: 0, error: null })
    expect(readFileSync(join(images, 'a.txt'), 'utf8')).toBe('mira，坐在窗边，柔和的光，半身\n')
    expect(requests[0]!.url).toBe('https://llm.example.test/chat/completions')
    const content = (requests[0]!.body['messages'] as Array<{ content: unknown }>)[1]!.content as Array<{
      type: string
      image_url?: { url: string }
    }>
    expect(content[1]!.image_url!.url.startsWith('data:image/png;base64,')).toBe(true)
  })

  it("sends the picture in each provider's own shape", async () => {
    for (const kind of ['anthropic', 'gemini', 'ollama'] as const) {
      vi.resetModules()
      requests.length = 0
      const { captions, project } = await setup(kind)
      reply = () =>
        json(
          kind === 'anthropic'
            ? { content: [{ type: 'text', text: 'mira 站着' }] }
            : kind === 'gemini'
              ? { candidates: [{ content: { parts: [{ text: 'mira 站着' }] } }] }
              : { message: { content: 'mira 站着' } },
        )
      expect((await captions.autoCaption(project.id, ['a.png', 'b.png'])).written).toBe(2)
      const body = JSON.stringify(requests[0]!.body)
      if (kind === 'anthropic') expect(body).toContain('"type":"image","source":{"type":"base64","media_type":"image/png"')
      if (kind === 'gemini') expect(body).toContain('"inline_data":{"mime_type":"image/png"')
      if (kind === 'ollama') expect(body).toContain('"images":["')
    }
  })

  it('stops and says so when the model cannot read pictures, and counts other failures', async () => {
    const { captions, project } = await setup('openai')
    reply = () => json({ error: { message: 'This model does not support image input' } }, 400)
    expect(await captions.autoCaption(project.id)).toEqual({ written: 0, failed: 0, error: captions.NO_IMAGE_INPUT, noPictures: true })
    // A picture the provider cannot take is a failed description, not a model that cannot see.
    reply = () => json({ error: { message: 'image too large: 8 MB, the limit is 5 MB' } }, 400)
    expect(await captions.autoCaption(project.id, ['a.png'])).toEqual({ written: 0, failed: 1, error: captions.ALL_FAILED })
    reply = () => json({ error: { message: 'Invalid image data' } }, 400)
    expect((await captions.autoCaption(project.id, ['a.png'])).error).toBe(captions.ALL_FAILED)
    reply = () => json({ error: { message: 'Vision is not supported for this model' } }, 400)
    expect(await captions.autoCaption(project.id, ['a.png'])).toMatchObject({ error: captions.NO_IMAGE_INPUT, noPictures: true })
    reply = () => json({ error: { message: 'overloaded' } }, 503)
    expect(await captions.autoCaption(project.id, ['a.png', 'b.png'])).toEqual({ written: 0, failed: 2, error: captions.ALL_FAILED })
  })

  it('asks the model 设置 › 语言模型 chose for 助手和漫画, not the newest one', async () => {
    await useKeyring()
    const ai = await import('@main/services/ai')
    const chosen = ai.saveProvider({ name: 'chosen', kind: 'openai', baseUrl: 'https://chosen.example.test', model: 'v', apiKey: 'k' })
    ai.saveProvider({ name: 'newest', kind: 'openai', baseUrl: 'https://newest.example.test', model: 'v', apiKey: 'k' })
    writeFileSync(join(root(), 'settings.json'), JSON.stringify({ languageProviderId: chosen.id }))
    const { captions, project } = await setup(null)
    reply = () => json({ choices: [{ message: { content: '坐在窗边' } }] })
    expect((await captions.autoCaption(project.id, ['a.png'])).written).toBe(1)
    expect(requests[0]!.url).toBe('https://chosen.example.test/chat/completions')
  })

  it('asks for the content only, not the style, when learning a 画风', async () => {
    const { captions } = await setup(null, 'style')
    expect(captions.captionPrompt('style', '')).toContain('不要描述画风')
    expect(captions.cleanCaption('一只猫坐在窗台上', 'style', '')).toBe('一只猫坐在窗台上')
  })

  it('writes nothing when a run started while the model was answering', async () => {
    const { captions, project, images } = await setup('openai')
    const store = await import('@main/services/training/store')
    reply = () => json({ choices: [{ message: { content: '坐在窗边' } }] })
    const fetchMock = vi.mocked(fetch)
    const answer = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (...args) => {
      await store.mutateTrainingProject(project.id, (current) => ({ ...current, state: 'starting' }))
      return answer(...args)
    })
    await expect(captions.autoCaption(project.id)).rejects.toMatchObject({ code: 'E_TRAINING_RUNNING' })
    expect(existsSync(join(images, 'a.txt'))).toBe(false)
  })
})
