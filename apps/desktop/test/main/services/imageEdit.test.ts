import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
vi.mock('node:https', async (original) => ({ ...(await original<typeof import('node:https')>()) }))
vi.mock('node:dns/promises', async (original) => ({ ...(await original<typeof import('node:dns/promises')>()) }))
vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }))
import { Readable } from 'node:stream'
import * as fs from 'node:fs'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as https from 'node:https'
import * as dns from 'node:dns/promises'
import { nativeImage, safeStorage } from 'electron'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { paths } from '@main/lib/paths'
import { saveProject, projectAssetsDir } from '@main/services/projects'
import { updateSettings } from '@main/services/settings'
import { createBuiltinMainDispatcher } from '@main/capabilities/builtinHandlers'
import { flushCapabilityAudit } from '@main/capabilities/audit'
import * as edit from '@main/services/imageEdit'
import { imageEditHttp, IMAGE_BYTES } from '@main/lib/imageEditHttp'
import { editProtocols } from '@shared/schemas'

const key = 'sk-test-not-a-real-token'
const draft = { name: 'Mine', protocol: 'openai-edits' as const, baseUrl: 'https://image.example/v1', model: 'test-model', apiKey: key }
const samples = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR42mNkYPjPwMDAxMDAgKAAEkIBBUEppJMAAAAASUVORK5CYII=',
  jpeg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCOALiMf//Z',
  webp: 'UklGRjoAAABXRUJQVlA4IC4AAACQAQCdASoCAAMAAUAmJaACdLoAA5gA/vtV4/+lwf/S4P/pcH/pcH8bss4bpAAA',
}
const bytes = Buffer.from(samples.png, 'base64')
// Only the TLS socket and peer are faked. Node's Request/FormData encode the real wire payload;
// Response decodes it independently. Nothing in this suite can reach a paid endpoint.
function peer(reply: unknown, status = 200, chunks?: Buffer[]) {
  const sent: { url: URL; headers: Record<string, string>; body: Buffer | undefined }[] = []
  const connected = vi.spyOn(https, 'request').mockImplementation(((
    url: URL,
    opts: { headers: Record<string, string> },
    cb: (res: Readable) => void,
  ) => {
    const req = new EventEmitter(),
      socket = new EventEmitter()
    queueMicrotask(() => {
      req.emit('socket', socket)
      socket.emit('secureConnect')
    })
    return Object.assign(req, {
      end: (data?: Buffer) => {
        sent.push({ url, headers: opts.headers, body: data })
        cb(
          Object.assign(Readable.from(chunks ?? [Buffer.from(JSON.stringify(reply))]), {
            statusCode: status,
            headers: { 'content-length': '1' },
          }),
        )
      },
      destroy: (err: Error) => req.emit('error', err),
    })
  }) as unknown as typeof https.request)
  return { sent, connected }
}
const root = useTempDataRoot()
beforeEach(() => {
  updateSettings({ externalImageEditEnabled: true, externalAgentsEnabled: false })
  vi.spyOn(safeStorage, 'getSelectedStorageBackend').mockReturnValue('gnome_libsecret')
})
afterEach(async () => {
  await flushCapabilityAudit()
  vi.restoreAllMocks()
})
function fixture(protocol: (typeof editProtocols)[number] = 'openai-edits') {
  const c = edit.saveImageChannel({ ...draft, protocol })
  const p = saveProject({ name: 'test', canvases: [] })
  const path = join(projectAssetsDir(p.id), 'source.png')
  writeFileSync(path, bytes)
  return { c, input: { projectId: p.id, path, channelId: c.id, revision: c.revision, prompt: 'redraw' } }
}

describe('external redraw boundaries', () => {
  it.each(editProtocols)('round trips %s inline bytes to a project asset', async (protocol) => {
    const { input } = fixture(protocol),
      data = bytes.toString('base64'),
      url = `data:image/png;base64,${data}`
    const { sent } = peer(
      protocol === 'openai-edits'
        ? { data: [{ b64_json: data }] }
        : protocol === 'gemini-native'
          ? { candidates: [{ content: { parts: [{ inlineData: { data, mimeType: 'image/png' } }] } }] }
          : { choices: [{ message: { images: [{ image_url: { url } }] } }] },
    )
    const result = await edit.runImageEdit(input)
    expect(result).toMatchObject({ width: 2, height: 3 })
    expect(readFileSync(result.path)).toEqual(bytes)
    expect(result.path.startsWith(projectAssetsDir(input.projectId))).toBe(true)
    expect(sent).toHaveLength(1)
    const req = sent[0]!
    expect(req.url.pathname).toBe(
      '/v1/' +
        { 'openai-edits': 'images/edits', 'openai-chat': 'chat/completions', 'gemini-native': 'models/test-model:generateContent' }[
          protocol
        ],
    )
    expect(req.url.href).not.toContain(key)
    if (protocol === 'gemini-native') {
      expect(req.headers['x-goog-api-key']).toBe(key)
      expect(JSON.parse(req.body!.toString()).contents[0].parts[1].inlineData).toEqual({ data, mimeType: 'image/png' })
    } else {
      expect(req.headers.authorization).toBe(`Bearer ${key}`)
      if (protocol === 'openai-edits') {
        const form = await new Response(new Uint8Array(req.body!), { headers: req.headers }).formData()
        expect(form.get('prompt')).toBe('redraw')
        expect(Buffer.from(await (form.get('image') as Blob).arrayBuffer())).toEqual(bytes)
      } else expect(JSON.parse(req.body!.toString()).messages[0].content[1].image_url.url).toBe(url)
    }
  })
  it.each(editProtocols)('discovers %s models without saving a channel', async (protocol) => {
    const { sent } = peer(
      protocol === 'gemini-native'
        ? { models: [{ name: 'models/text' }, { name: 'models/image-1' }] }
        : { data: [{ id: 'text' }, { id: 'image-1' }, { id: key }] },
    )
    expect(await edit.discoverImageModels({ protocol, baseUrl: draft.baseUrl, apiKey: key })).toEqual(['image-1', 'text'])
    expect(sent[0]?.body).toBeUndefined()
    expect(sent[0]?.url.pathname).toBe('/v1/models')
    expect(existsSync(paths.imageEditChannels())).toBe(false)
  })
  it('keeps, replaces, removes keys, never reuses one at a changed origin or exposes it in metadata', async () => {
    const { apiKey: _key, ...fields } = draft,
      c = edit.saveImageChannel(draft)
    expect(
      JSON.stringify([
        c,
        edit.listImageChannels(),
        readFileSync(paths.imageEditCredentials(), 'utf8'),
        readFileSync(paths.imageEditChannels(), 'utf8'),
      ]),
    ).not.toContain(key)
    expect(existsSync(paths.aiCredentials())).toBe(false)
    expect(edit.saveImageChannel({ ...fields, id: c.id }).hasKey).toBe(true)
    const { connected } = peer({ data: [] })
    await expect(edit.discoverImageModels({ id: c.id, protocol: draft.protocol, baseUrl: 'https://different.example' })).rejects.toThrow()
    expect(connected).not.toHaveBeenCalled()
    expect(edit.saveImageChannel({ ...fields, id: c.id, baseUrl: 'https://other.example' }).hasKey).toBe(false)
    expect(edit.saveImageChannel({ ...fields, id: c.id, apiKey: 'new-key' }).hasKey).toBe(true)
    expect(edit.saveImageChannel({ ...fields, id: c.id, apiKey: null }).hasKey).toBe(false)
    edit.removeImageChannel(c.id)
    expect(edit.listImageChannels()).toEqual([])
  })
  it('denies closed channels without side effects', async () => {
    updateSettings({ externalImageEditEnabled: false, externalAgentsEnabled: true })
    const { connected } = peer(null)
    const before = readdirSync(root())
    expect(() => edit.listImageChannels()).toThrow()
    expect(() => edit.saveImageChannel(draft)).toThrow()
    expect(() => edit.removeImageChannel('unknown')).toThrow()
    await expect(edit.discoverImageModels(draft)).rejects.toThrow()
    await expect(edit.runImageEdit({ channelId: 'x', revision: 'x', projectId: 'x', path: 'x.png', prompt: 'x' })).rejects.toThrow()
    const dispatch = createBuiltinMainDispatcher()
    expect((await dispatch.execute({ name: 'image.edit.run' })).ok).toBe(false)
    await flushCapabilityAudit()
    expect(readdirSync(root())).toEqual(before)
    expect(connected).not.toHaveBeenCalled()
  })
  it.each(['image switch', 'agent switch', 'channel revision', 'file bytes', 'refusal', 'read only'])(
    'does not transmit after an approval boundary changes: %s',
    async (reason) => {
      updateSettings({ externalAgentsEnabled: true })
      const { input, c } = fixture()
      const { revision: _revision, ...args } = input
      const dispatcher = createBuiltinMainDispatcher()
      const { connected } = peer(null)
      const approve = vi.fn(async (req: { summary: string }) => {
        expect(req.summary).toContain('https://image.example')
        if (reason === 'image switch') updateSettings({ externalImageEditEnabled: false })
        if (reason === 'agent switch') updateSettings({ externalAgentsEnabled: false })
        if (reason === 'channel revision') edit.saveImageChannel({ ...draft, id: c.id })
        if (reason === 'file bytes') writeFileSync(input.path, Buffer.concat([bytes, Buffer.from('changed after approval')]))
        return reason !== 'refusal'
      })
      dispatcher.requestApproval = approve
      const result = await dispatcher.execute({
        name: 'image.edit.run',
        arguments: args,
        source: 'external-agent',
        readOnly: reason === 'read only',
      })
      expect(result.ok).toBe(false)
      expect(approve).toHaveBeenCalledTimes(reason === 'read only' ? 0 : 1)
      expect(connected).not.toHaveBeenCalled()
    },
  )
  it.each(['%%%', 'aGVsbG8=', 'https://other.example/output.png'])(
    'rejects invalid images without downloading or importing %s',
    async (value) => {
      const { input } = fixture()
      const { sent } = peer({ data: [{ b64_json: value }] })
      await expect(edit.runImageEdit(input)).rejects.toThrow()
      expect(sent).toHaveLength(1)
      expect(readdirSync(projectAssetsDir(input.projectId))).toEqual(['source.png'])
    },
  )
  it('imports the approved MCP result, but never lists the action with either switch off or for proposal-only', async () => {
    const { input } = fixture()
    const { revision: _rev, channelId: _id, ...args } = input
    const dispatcher = createBuiltinMainDispatcher()
    const ids = () => dispatcher.list().actions.map((x) => x.id)
    expect(ids()).not.toContain('image.edit.run')
    updateSettings({ externalAgentsEnabled: true })
    expect(ids()).toContain('image.edit.run')
    expect(dispatcher.list({ profile: 'proposal-only' }).actions.map((x) => x.id)).not.toContain('image.edit.run')
    const { sent } = peer({ data: [{ b64_json: bytes.toString('base64') }] })
    dispatcher.requestApproval = async () => true
    const result = await dispatcher.execute({ name: 'image.edit.run', arguments: args, source: 'external-agent' })
    expect(result.ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(result.content).not.toContain(key)
    expect(readdirSync(projectAssetsDir(input.projectId))).toHaveLength(2)
    updateSettings({ externalImageEditEnabled: false })
    expect(ids()).not.toContain('image.edit.run')
  })
  it.each(['jpeg', 'webp'] as const)('decodes a real %s response and stores an engine-readable asset', async (format) => {
    const { input } = fixture()
    // Electron is faked here; the real nativeImage decodes this WebP to the 2 × 3 PNG.
    vi.spyOn(nativeImage, 'createFromBuffer').mockReturnValue({ isEmpty: () => false, toPNG: () => bytes } as never)
    peer({ data: [{ b64_json: samples[format] }] })
    const result = await edit.runImageEdit(input)
    expect(result).toMatchObject({ width: 2, height: 3 })
    const saved = readFileSync(result.path)
    if (format === 'webp') expect(saved.subarray(0, 8)).toEqual(bytes.subarray(0, 8))
    else expect(saved).toEqual(Buffer.from(samples.jpeg, 'base64'))
  })
  it('does not import a WebP reply Electron cannot decode', async () => {
    const { input } = fixture()
    peer({ data: [{ b64_json: samples.webp }] })
    await expect(edit.runImageEdit(input)).rejects.toThrow()
    expect(readdirSync(projectAssetsDir(input.projectId))).toEqual(['source.png'])
  })
  it.each(['png', 'jpeg', 'webp'] as const)('does not publish a %s with a valid size but missing pixels', async (format) => {
    const { input } = fixture()
    const data = Buffer.from(samples[format], 'base64').subarray(0, { png: 33, jpeg: 185, webp: 30 }[format])
    peer({ data: [{ b64_json: data.toString('base64') }] })
    await expect(edit.runImageEdit(input)).rejects.toThrow()
    expect(readdirSync(projectAssetsDir(input.projectId))).toEqual(['source.png'])
  })
  it.each(['png', 'jpeg', 'webp'] as const)('does not publish even a one-byte truncated %s', async (format) => {
    const { input } = fixture()
    const incomplete = Buffer.from(samples[format], 'base64').subarray(0, -1)
    peer({ data: [{ b64_json: incomplete.toString('base64') }] })
    await expect(edit.runImageEdit(input)).rejects.toThrow()
    expect(readdirSync(projectAssetsDir(input.projectId))).toEqual(['source.png'])
  })
  it.each([
    [16384, 16384],
    [6000, 5000],
    [8193, 1],
  ])('rejects a %i × %i WebP before entering the decoder', async (width, height) => {
    const { input } = fixture()
    // Header only: no image or allocation of the claimed size is ever needed in this test.
    const header = Buffer.alloc(30)
    header.write('RIFF')
    header.writeUInt32LE(22, 4)
    header.write('WEBPVP8X', 8)
    header.writeUInt32LE(10, 16)
    header.writeUIntLE(width - 1, 24, 3)
    header.writeUIntLE(height - 1, 27, 3)
    peer({ data: [{ b64_json: header.toString('base64') }] })
    const decode = vi.spyOn(nativeImage, 'createFromBuffer')
    await expect(edit.runImageEdit(input)).rejects.toThrow()
    expect(decode).not.toHaveBeenCalled()
    expect(readdirSync(projectAssetsDir(input.projectId))).toEqual(['source.png'])
  })
  it.each(['gpt-image-1', 'openai/gpt-image-1', 'vendor/gpt-image-2.6', 'vendor/not-gpt-image'])(
    'negotiates response_format for %s',
    async (model) => {
      const { input, c } = fixture()
      const updated = edit.saveImageChannel({ ...draft, id: c.id, model })
      const { sent } = peer({ data: [{ b64_json: samples.png }] })
      await edit.runImageEdit({ ...input, revision: updated.revision })
      const { body, headers } = sent[0]!
      const form = await new Response(new Uint8Array(body!), { headers }).formData()
      expect(form.get('response_format')).toBe(model === 'vendor/not-gpt-image' ? 'b64_json' : null)
    },
  )
  it('aborts the live HTTPS signal after approval and ignores a late successful response', async () => {
    updateSettings({ externalAgentsEnabled: true })
    const { input } = fixture()
    const { revision: _revision, ...args } = input
    const caller = new AbortController(),
      dispatcher = createBuiltinMainDispatcher()
    dispatcher.requestApproval = async () => true
    let markSent!: (wire: AbortSignal) => void, respond!: () => void
    const sent = new Promise<AbortSignal>((resolve) => {
      markSent = resolve
    })
    const response = new Promise<void>((resolve) => {
      respond = resolve
    })
    vi.spyOn(https, 'request').mockImplementation(((_url: URL, opts: { signal: AbortSignal }, cb: (res: Readable) => void) => {
      const req = new EventEmitter(),
        socket = new EventEmitter()
      queueMicrotask(() => {
        req.emit('socket', socket)
        socket.emit('secureConnect')
      })
      return Object.assign(req, {
        end: () => {
          markSent(opts.signal)
          void response.then(() =>
            cb(Object.assign(Readable.from([Buffer.from(JSON.stringify({ data: [{ b64_json: samples.png }] }))]), { statusCode: 200 })),
          )
        },
      })
    }) as unknown as typeof https.request)
    const running = dispatcher.execute({ name: 'image.edit.run', arguments: args, source: 'external-agent', signal: caller.signal })
    const wire = await sent
    caller.abort()
    respond()
    expect((await running).ok).toBe(false)
    expect(wire.aborted).toBe(true)
    expect(readdirSync(projectAssetsDir(input.projectId))).toEqual(['source.png'])
  })
  it('cancels a dialog run in flight, even under a reused id, and saves nothing, but only while the switch is on', async () => {
    const { input } = fixture()
    const runId = '7f9e2c41-5d3a-4b8e-9c1f-2a6b8d4e0f13'
    let markSent!: (wire: AbortSignal) => void, respond!: () => void
    const sent = new Promise<AbortSignal>((resolve) => {
      markSent = resolve
    })
    const response = new Promise<void>((resolve) => {
      respond = resolve
    })
    vi.spyOn(https, 'request').mockImplementation(((_url: URL, opts: { signal: AbortSignal }, cb: (res: Readable) => void) => {
      const req = new EventEmitter(),
        socket = new EventEmitter()
      queueMicrotask(() => {
        req.emit('socket', socket)
        socket.emit('secureConnect')
      })
      return Object.assign(req, {
        end: () => {
          markSent(opts.signal)
          void response.then(() =>
            cb(Object.assign(Readable.from([Buffer.from(JSON.stringify({ data: [{ b64_json: samples.png }] }))]), { statusCode: 200 })),
          )
        },
      })
    }) as unknown as typeof https.request)
    // An earlier run under the same id ends first; it must not unregister the live one.
    const earlier = edit.runDialogImageEdit({ ...input, projectId: 'missing', runId })
    const running = edit.runDialogImageEdit({ ...input, runId })
    await expect(earlier).rejects.toThrow('项目位置已改变')
    const wire = await sent
    edit.cancelImageEdit(runId)
    respond()
    await expect(running).rejects.toThrow('已取消重绘')
    expect(wire.aborted).toBe(true)
    expect(readdirSync(projectAssetsDir(input.projectId))).toEqual(['source.png'])
    updateSettings({ externalImageEditEnabled: false })
    expect(() => edit.cancelImageEdit(runId)).toThrow()
  })
  it('creates a missing assets folder instead of failing in English', async () => {
    const { input } = fixture()
    const other = saveProject({ name: 'empty', canvases: [] })
    rmSync(projectAssetsDir(other.id), { recursive: true, force: true })
    peer({ data: [{ b64_json: samples.png }] })
    const result = await edit.runImageEdit({ ...input, projectId: other.id })
    expect(result.path.startsWith(projectAssetsDir(other.id))).toBe(true)
  })
  it.each(['project folder', 'assets', 'project.json'] as const)(
    'refuses a project whose %s is a link below the projects folder',
    async (part) => {
      const { input } = fixture()
      const assets = projectAssetsDir(input.projectId)
      const target = { 'project folder': dirname(assets), assets, 'project.json': join(dirname(assets), 'project.json') }[part]
      const moved = join(`${root()}-elsewhere`, 'moved')
      mkdirSync(dirname(moved), { recursive: true })
      try {
        renameSync(target, moved)
        symlinkSync(moved, target, part === 'project.json' ? 'file' : 'junction')
        const { connected } = peer({ data: [{ b64_json: samples.png }] })
        await expect(edit.runImageEdit(input)).rejects.toThrow('项目位置已改变')
        expect(connected).not.toHaveBeenCalled()
      } finally {
        rmSync(dirname(moved), { recursive: true, force: true })
      }
    },
  )
  it('refuses a MIME mismatch instead of importing the inline bytes', async () => {
    const { input } = fixture('gemini-native')
    peer({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: bytes.toString('base64') } }] } }] })
    await expect(edit.runImageEdit(input)).rejects.toThrow()
    expect(readdirSync(projectAssetsDir(input.projectId))).toHaveLength(1)
  })
  it('refuses insecure storage instead of writing the key or channel', () => {
    vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false)
    expect(() => edit.saveImageChannel(draft)).toThrow()
    expect(existsSync(paths.imageEditChannels())).toBe(false)
    expect(existsSync(paths.imageEditCredentials())).toBe(false)
  })
  it('sets damaged metadata aside so channels can be added again', () => {
    writeFileSync(paths.imageEditChannels(), 'broken')
    expect(edit.listImageChannels()).toEqual([])
    const backups = readdirSync(root()).filter((name) => name.startsWith('image-edit-channels.json.broken-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(root(), backups[0]!), 'utf8')).toBe('broken')
    expect(edit.saveImageChannel(draft).name).toBe(draft.name)
    expect(edit.listImageChannels()).toHaveLength(1)
  })
  it('keeps settings usable when a damaged channels file cannot be moved aside', () => {
    writeFileSync(paths.imageEditChannels(), 'broken')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    })
    expect(edit.listImageChannels()).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    expect(edit.saveImageChannel(draft).name).toBe(draft.name)
  })
  it('redraws in a project under a data folder reached through a link', async () => {
    const link = `${root()}-link`
    symlinkSync(root(), link, 'junction')
    try {
      process.env['MOSSSTUDIO_DATA'] = link
      const { input } = fixture()
      expect(input.path.startsWith(link)).toBe(true)
      peer({ data: [{ b64_json: samples.png }] })
      expect(await edit.runImageEdit(input)).toMatchObject({ width: 2, height: 3 })
    } finally {
      rmSync(link, { force: true })
    }
  })
  it('rejects an oversized source before connecting', async () => {
    const { input } = fixture()
    writeFileSync(input.path, Buffer.alloc(IMAGE_BYTES + 1))
    const { connected } = peer(null)
    await expect(edit.runImageEdit(input)).rejects.toThrow()
    expect(connected).not.toHaveBeenCalled()
  })
  it.each([302, 401])('never follows a redirect or forwards provider error text (%s)', async (status) => {
    const { sent } = peer({ location: 'https://elsewhere.example', error: key }, status)
    const err = await edit.discoverImageModels(draft).catch((err: Error) => err)
    expect(err).toBeInstanceOf(Error)
    expect(String(err)).not.toContain(key)
    expect(sent).toHaveLength(1)
  })
  it('rejects a streaming body larger than declared', async () => {
    peer(null, 200, [Buffer.alloc(512 * 1024, 32), Buffer.from('{}')])
    await expect(imageEditHttp(draft.baseUrl, {}, null, () => {})).rejects.toThrow()
  })
  it('rejects mixed public/private DNS on the actual HTTPS socket', async () => {
    const resolver = vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ] as never)
    await expect(imageEditHttp(draft.baseUrl, {}, null, () => {})).rejects.toThrow()
    expect(resolver).toHaveBeenCalledOnce()
  })
})
import { publicImageUrl, publicAddress } from '@main/lib/imageEditHttp'

describe('public image channel destinations', () => {
  it.each([
    'http://example.org',
    'https://foo:bar@example.org',
    'https://@example.org',
    'https:example.org',
    'https://example.org/?a=b',
    'https://example.org/#part',
    'https://127.0.0.1',
    'https://[::ffff:127.0.0.1]',
  ])('rejects %s before opening a socket', (url) => expect(() => publicImageUrl(url)).toThrow())
  it.each(['10.0.0.1', '169.254.169.254', '192.168.1.1', '100.64.2.1', 'fd00::1', 'fe80::1', '::1', '::ffff:8.8.8.8'])(
    'rejects DNS answer %s',
    (ip) => expect(publicAddress(ip)).toBe(false),
  )
  it('accepts a public DNS answer', () => expect(publicAddress('8.8.8.8')).toBe(true))
})
