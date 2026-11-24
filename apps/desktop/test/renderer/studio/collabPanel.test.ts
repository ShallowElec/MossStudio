import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useApp } from '@renderer/store'
import { Ipc } from '@shared/channels'
import { canvasFixture, settingsFixture } from '@test/mocks/backend/fixtures'
import { createMockBackend } from '@test/mocks/backend'
import { scenario } from '@test/mocks/backend/scenarios'

/** The 协同 panel exists only while 设置 › 功能 › 外部 Agent is on. */
const withExternalAgents = () =>
  scenario('ready', { settings: settingsFixture({ onboardingState: 'completed', externalAgentsEnabled: true }) })
import { ToastProvider } from '@renderer/components/ui'
import { ApiError } from '@renderer/lib/api'
import { prettyArgs } from '@renderer/pages/studio/assistant/ApprovalDock'
import { AttachmentTray, MAX_ATTACHMENT_BYTES, planAttachments, useAttachments } from '@renderer/pages/studio/assistant/AttachmentTray'
import { ImageLightbox } from '@renderer/components/common/ImageLightbox'
import { folderTail } from '@renderer/pages/studio/assistant/CollabStatusBar'
import { COMPACT_PACKS, effectivePacks, listPackRows, togglePack, toolProfileLine } from '@renderer/pages/studio/assistant/CollabToolbar'
import {
  chooseSession,
  createCollabClient,
  mcpConfigJson,
  normalizeApprovals,
  normalizeBackends,
  normalizeMcpClients,
  normalizeMessages,
  normalizeModels,
  normalizeSessions,
  normalizeStats,
  sanitizeMessageText,
} from '@renderer/pages/studio/assistant/collabClient'
import { CollabPanel, agentShortName, connectionLost, replyImages } from '@renderer/pages/studio/assistant/CollabPanel'
import { capabilityLabel, contextChips, formatBoardContext } from '@renderer/pages/studio/assistant/collabContext'
import { GlobalApprovalOverlay } from '@renderer/pages/studio/assistant/GlobalApprovalOverlay'
import { McpConnectDialog } from '@renderer/pages/studio/assistant/McpConnectDialog'
import { joinProjectPath, newFolderProblem, parentFolder } from '@renderer/pages/studio/assistant/NewSessionDialog'
import { bindSession, readSessionBinding } from '@renderer/pages/studio/assistant/sessionBindings'
import { conversationFigures } from '@renderer/pages/studio/assistant/SessionStats'
import { elapsedLabel, mergeSteps } from '@renderer/pages/studio/assistant/StepProgressDock'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  localStorage.clear()
  sessionStorage.clear()
})

const missing = new ApiError({ code: 'E_MOCK_UNHANDLED', message: 'mock backend has no handler' })
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

/** Types into a React-controlled field the way a person does. */
function fill(field: Element | null, value: string): void {
  if (!field) throw new Error('field not found')
  const proto =
    field instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

describe('collab client', () => {
  it('accepts both list shapes and keeps only ACP backends the hub reports', () => {
    const one = [{ id: 's1', title: 'A', cwd: 'F:/w', running: true }, { title: 'no id' }]
    expect(normalizeSessions(one)).toEqual([{ id: 's1', title: 'A', cwd: 'F:/w', running: true }])
    expect(normalizeSessions({ sessions: one })).toEqual(normalizeSessions(one))
    expect(normalizeBackends([{ id: 'codex-acp', label: 'Codex ACP', available: true, connected: true }]).map((item) => item.id)).toEqual([
      'codex-acp',
    ])
    // Nothing reported: Codex and the custom command are still offered.
    expect(normalizeBackends([]).map((item) => item.id)).toEqual(['codex-acp', 'custom-acp'])
    expect(
      normalizeMessages({ messages: [{ seq: 2, role: 'assistant', text: 'hi' }, { seq: 'x' }], steps: [{ name: 'read', ok: false }] }),
    ).toEqual({
      messages: [{ seq: 2, role: 'assistant', text: 'hi' }],
      hasMore: false,
      asOfSeq: 2,
      steps: [{ id: 'step-0', title: 'read', status: 'error' }],
    })
  })

  it('picks the remembered conversation, else a running one, else the newest', () => {
    const list = [
      { id: 'old', title: 'a', updatedAt: 1 },
      { id: 'new', title: 'b', updatedAt: 5 },
      { id: 'busy', title: 'c', updatedAt: 2, running: true },
    ]
    expect(chooseSession(list, 'old')).toBe('old')
    expect(chooseSession(list, 'gone')).toBe('busy')
    expect(chooseSession(list.slice(0, 2), '')).toBe('new')
    expect(chooseSession([], 'x')).toBe('')
  })

  it('reads models, stats and approvals defensively', () => {
    expect(
      normalizeModels({ models: ['a', { id: 'b', label: 'B', provider: 'p' }], currentModel: 'a', reasoningEfforts: ['low', 3] }),
    ).toEqual({
      models: [
        { id: 'a', label: 'a' },
        { id: 'b', label: 'B', provider: 'p' },
      ],
      currentModel: 'a',
      reasoningEfforts: ['low'],
    })
    // Efforts reported on the current model, as the hub's ACP driver does.
    expect(normalizeModels({ models: [{ id: 'm', label: 'M', reasoningEfforts: ['high'] }], currentModel: 'm' }).reasoningEfforts).toEqual([
      'high',
    ])
    expect(normalizeStats({ model: 'm', userTurns: 3, tokenUsage: { input: 10, output: 5, contextWindow: 100 } })).toEqual({
      model: 'm',
      turnCount: 3,
      tokenUsage: { input: 10, output: 5, total: undefined, limit: 100 },
    })
    expect(normalizeApprovals({ pending: [{ id: 'a', actionId: 'x.y', source: 'weird' }] })[0]).toMatchObject({
      id: 'a',
      title: 'x.y',
      source: 'external-agent',
    })
  })

  it('reports only verified configuration and copies the bridge resolved by main for both stdio formats', () => {
    const clients = normalizeMcpClients({ clients: [{ id: 'claude-code', state: 'conflict' }, { id: 'other' }] })
    expect(clients.map((c) => [c.id, c.state])).toEqual([
      ['dsh', 'unknown'],
      ['codex', 'unknown'],
      ['claude-code', 'conflict'],
    ])
    const bridge = { command: '/opt/MossStudio', args: ['/b.js'], env: { ELECTRON_RUN_AS_NODE: '1', MOSSSTUDIO_MCP_DISCOVERY: '/d.json' } }
    const connection = { url: 'http://127.0.0.1:1/mcp', token: 'secret', toolCount: 3, bridge }
    const config = JSON.parse(mcpConfigJson(connection, 'all'))
    expect(Object.keys(config.mcpServers)).toEqual(['mossstudio', 'mossstudio-stdio'])
    expect(config.mcpServers['mossstudio-stdio']).toEqual(bridge)
    expect(JSON.parse(mcpConfigJson(connection, 'dsh'))).toEqual({
      serverName: 'mossstudio',
      transport: 'stdio',
      ...bridge,
      toolCallTimeoutMs: 180000,
    })
  })

  it('falls back when the hub is missing instead of failing the panel', async () => {
    const client = createCollabClient(
      async <T>(channel: string): Promise<T> => {
        if (channel === Ipc.capabilitiesAudit)
          return [{ id: 'a1', actionId: 'studio.board.read', ok: true, durationMs: 12, timestamp: 't' }] as T
        throw missing
      },
      () => () => undefined,
    )
    const backends = await client.listBackends()
    expect(backends.find((item) => item.id === 'codex-acp')).toMatchObject({
      available: false,
      detail: '这个版本的 MossStudio 还不能连接它',
    })
    expect(backends.find((item) => item.id === 'custom-acp')?.detail).toBeUndefined()
    expect(await client.listApprovals()).toEqual([])
    expect(await client.listModels('codex-acp')).toBeNull()
    expect(await client.setModel({ backendId: 'codex-acp', sessionId: 's', model: 'm' })).toBe(false)
    expect(await client.sessionStats('codex-acp', 's')).toBeNull()
    expect(await client.mcpClients()).toBeNull()
    expect((await client.audit(5))[0]).toMatchObject({ id: 'a1', durationMs: 12, ok: true })
  })

  it('creates a session with only the fields given and sends the tool profile with a message', async () => {
    const calls: Array<[string, unknown]> = []
    const client = createCollabClient(
      async <T>(channel: string, payload?: unknown): Promise<T> => {
        calls.push([channel, payload])
        return (channel === Ipc.agentHubCreateSession ? { sessionId: 'n1' } : undefined) as T
      },
      () => () => undefined,
    )
    expect(await client.createSession('codex-acp', { title: 'T', cwd: '', projectId: 'p' })).toBe('n1')
    await client.setToolProfile('custom', ['studio.ask'])
    await client.setToolProfile('atomic', ['studio.ask'])
    expect(calls).toEqual([
      [Ipc.agentHubCreateSession, { backendId: 'codex-acp', title: 'T', projectId: 'p' }],
      [Ipc.mcpSetProfile, { profile: 'custom', enabledPacks: ['studio.ask'] }],
      [Ipc.mcpSetProfile, { profile: 'atomic' }],
    ])
  })

  it('hears stream and approval events and drops malformed ones', () => {
    const listeners = new Map<string, (data: unknown) => void>()
    const client = createCollabClient(
      async () => {
        throw missing
      },
      <T>(channel: string, callback: (data: T) => void) => {
        listeners.set(channel, callback as (data: unknown) => void)
        return () => listeners.delete(channel)
      },
    )
    const seen: string[] = []
    const off = client.onStream((event) => seen.push(`${event.type}:${event.text ?? ''}`))
    listeners.get('event:agent-hub')!({ backendId: 'b', sessionId: 's', type: 'delta', text: 'a' })
    listeners.get('event:agent-hub')!({ backendId: 'b', type: 'delta', text: 'no session' })
    listeners.get('event:agent-hub')!({ backendId: 'b', sessionId: 's', type: 'bogus' })
    expect(seen).toEqual(['delta:a'])
    let pending = 0
    client.onApprovals((list) => (pending = list.length))
    listeners.get('event:capability-approval')!({ pending: [{ id: 'x', actionId: 'studio.cards.delete' }] })
    expect(pending).toBe(1)
    off()
    expect(listeners.has('event:agent-hub')).toBe(false)
  })

  it('strips system reminders and the attached board context from bubbles', () => {
    expect(sanitizeMessageText('<system-reminder>x\ny</system-reminder>你好\n\n[Current Studio context]\nStudio project: A')).toBe('你好')
    expect(sanitizeMessageText('<system-reminder>only</system-reminder>')).toBe('')
    expect(sanitizeMessageText('普通回复')).toBe('普通回复')
  })

  it('keeps only embedded raster pictures in messages and replies', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    expect(
      normalizeMessages({
        messages: [
          {
            seq: 1,
            role: 'assistant',
            text: '',
            images: [png, 'data:image/svg+xml;base64,PHN2Zz4=', 'https://example.com/a.png', 'file:///etc/passwd', 7, png, png, png],
          },
          { seq: 2, role: 'user', text: 'x', images: 'data:image/png;base64,AAAA' },
        ],
      }).messages,
    ).toEqual([
      { seq: 1, role: 'assistant', text: '', images: [png] },
      { seq: 2, role: 'user', text: 'x' },
    ])
    const { urlTransform, components } = replyImages
    const transform = urlTransform as (url: string, key: string) => string
    expect(transform(png, 'src')).toBe(png)
    for (const url of ['https://example.com/a.png', 'file:///etc/passwd', 'data:image/svg+xml;base64,PHN2Zz4='])
      expect(transform(url, 'src')).toBe('')
    expect(transform('https://example.com/', 'href')).toBe('https://example.com/')
    expect(transform('javascript:alert(1)', 'href')).toBe('')
    const img = components!.img as (props: { node: { properties: { src?: string } } }) => { type: unknown; props: { path?: string } }
    expect(img({ node: { properties: { src: png } } }).props.path).toBe(png)
    expect(img({ node: { properties: { src: 'https://example.com/a.png' } } }).type).toBe('span')
  })
})

describe('collab panel helpers', () => {
  it('limits attachments to four pictures of at most 8 MB', () => {
    const png = (name: string, size = 10) => ({ name, type: 'image/png', size })
    expect(planAttachments(0, [png('a'), { name: 'b.txt', type: 'text/plain', size: 1 }, png('c', MAX_ATTACHMENT_BYTES + 1)])).toEqual({
      accepted: [0],
      problem: '「b.txt」不是图片，只能附带图片。',
    })
    expect(planAttachments(3, [png('a'), png('b')])).toEqual({ accepted: [0], problem: '最多附带 4 张图片。' })
  })

  it('lists every built-in pack and turns pack ticks into a custom profile starting from what the mode showed', () => {
    // 14 MossStudio packs, the shared remote.hosts pack and the two opt-in guide packs; image.edit only when switched on.
    expect(listPackRows()).toHaveLength(17)
    expect(listPackRows(true).map((row) => row.id)).toContain('image.edit')
    expect(listPackRows().map((row) => row.id)).not.toContain('image.edit')
    expect(listPackRows().map((row) => row.id)).toContain('remote.hosts')
    expect(listPackRows().map((row) => row.id)).toContain('skill.moss.standard')
    expect(listPackRows().map((row) => row.id)).toContain('skill.moss.layout')
    expect(effectivePacks({ mode: 'compact', packs: [] })).toEqual(COMPACT_PACKS)
    for (const mode of ['compact', 'atomic', 'proposal-only'] as const) {
      expect(effectivePacks({ mode, packs: [] }), mode).not.toContain('skill.moss.standard')
      expect(effectivePacks({ mode, packs: [] }), mode).not.toContain('skill.moss.layout')
    }
    expect(effectivePacks({ mode: 'moss-standard', packs: [] })).toContain('skill.moss.standard')
    expect(effectivePacks({ mode: 'moss-standard', packs: [] })).not.toContain('skill.moss.layout')
    expect(effectivePacks({ mode: 'moss-standard', packs: [] })).not.toContain('studio.board.regions')
    expect(effectivePacks({ mode: 'moss-layout', packs: [] })).toContain('skill.moss.standard')
    expect(effectivePacks({ mode: 'moss-layout', packs: [] })).toContain('skill.moss.layout')
    expect(effectivePacks({ mode: 'moss-layout', packs: [] })).toContain('studio.board.regions')
    const next = togglePack({ mode: 'compact', packs: [] }, 'studio.ask')
    expect(next.mode).toBe('custom')
    expect(next.packs).not.toContain('studio.ask')
    expect(next.packs).toHaveLength(COMPACT_PACKS.length - 1)
    expect(togglePack({ mode: 'atomic', packs: [] }, 'training.jobs').packs).toHaveLength(14)
    expect(toolProfileLine({ mode: 'custom', packs: ['studio.ask'] })).toBe('Tools allowed: studio.ask')
    expect(toolProfileLine({ mode: 'moss-standard', packs: [] })).toContain('skill.moss.standard')
    expect(toolProfileLine({ mode: 'moss-standard', packs: [] })).not.toContain('skill.moss.layout')
    expect(toolProfileLine({ mode: 'moss-layout', packs: [] })).toContain('skill.moss.layout')
    expect(toolProfileLine({ mode: 'atomic', packs: [] })).toBe('Tools allowed: the atomic set')
    expect(toolProfileLine({ mode: 'compact', packs: [] })).toBe('Tools allowed: the compact set')
  })

  it('works out the new project folder and refuses names that would escape it', () => {
    expect(parentFolder('F:\\work\\poster\\')).toBe('F:\\work')
    expect(parentFolder('F:\\poster')).toBe('F:\\')
    expect(parentFolder('/home/me/poster')).toBe('/home/me')
    expect(parentFolder('/poster')).toBe('/')
    expect(parentFolder(undefined)).toBe('')
    expect(joinProjectPath('F:\\work\\', ' harbor ')).toBe('F:\\work\\harbor')
    expect(joinProjectPath('F:', 'harbor')).toBe('F:\\harbor')
    expect(joinProjectPath('/', 'harbor')).toBe('/harbor')
    expect(joinProjectPath('/home/me', '')).toBe('')
    expect(newFolderProblem('F:\\work', 'harbor')).toBe('')
    expect(newFolderProblem('', 'harbor')).toBe('先选择新项目所在的目录。')
    expect(newFolderProblem('work', 'harbor')).toContain('完整路径')
    expect(newFolderProblem('F:\\work\\..\\x', 'harbor')).toContain('..')
    for (const name of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', '..', 'x..y'])
      expect(newFolderProblem('F:\\work', name)).toContain('文件夹名不能包含')
  })

  it('names Agents, tools, folders, elapsed time and merged steps the way the panel shows them', () => {
    expect(agentShortName('Codex ACP')).toBe('Codex')
    expect(agentShortName('自定义 ACP')).toBe('自定义')
    expect(capabilityLabel('studio_generate')).not.toBe('studio_generate')
    expect(capabilityLabel('unknown.tool')).toBe('unknown.tool')
    expect(folderTail('F:\\work\\poster\\')).toBe('poster')
    expect(elapsedLabel(72_400)).toBe('1 分 12 秒')
    expect(elapsedLabel(18_000)).toBe('18 秒')
    expect(
      mergeSteps(
        [{ id: 'a', title: 'A', status: 'running' }],
        [
          { id: 'b', title: 'B', status: 'done' },
          { id: 'a', title: 'A', status: 'error', error: 'x' },
        ],
      ),
    ).toEqual([
      { id: 'a', title: 'A', status: 'error', error: 'x' },
      { id: 'b', title: 'B', status: 'done' },
    ])
    expect(prettyArgs('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyArgs('not json')).toBe('not json')
  })

  it('counts turns and estimates size when the Agent reports no token usage', () => {
    const messages = [
      { seq: 1, role: 'user' as const, text: 'abcd' },
      { seq: 2, role: 'assistant' as const, text: 'ef' },
    ]
    expect(conversationFigures(messages, null)).toEqual({ messages: 2, turns: 1, usage: { used: 6, estimated: true } })
    expect(conversationFigures(messages, { tokenUsage: { input: 100, output: 20, limit: 1000 } }).usage).toEqual({
      used: 120,
      limit: 1000,
      estimated: false,
    })
  })
})

describe('board context chips', () => {
  const canvas = canvasFixture({
    title: 'Harbor',
    prompt: '灯塔',
    summary: { caption: '', canvas: 'single', meta: [] },
    layers: [{ id: 'r1', kind: 'object', caption: 'sail', bbox: [1, 2, 3, 4], visible: true, locked: false, opacity: 1 }],
  })
  const board = { projectId: 'p', projectName: 'P', canvas, selectedRegionId: 'r1' }

  it('offers one chip per part', () => {
    const chips = contextChips(board)
    expect(chips.map((chip) => chip.part)).toEqual(['canvas', 'model', 'prompt', 'regions', 'selection'])
    expect(chips.find((chip) => chip.part === 'model')?.label).toBe('模型与 LoRA')
    expect(contextChips({ ...board, canvas: null })).toEqual([])
  })

  it('keeps the default output and leaves out exactly the parts turned off', () => {
    const all = formatBoardContext(board)
    expect(all).toContain('Prompt: 灯塔')
    expect(all).toContain('Selected region: object: sail')
    expect(all).not.toContain('Left out')
    const trimmed = formatBoardContext(board, { prompt: false, selection: false, model: false })
    expect(trimmed).not.toContain('灯塔')
    expect(trimmed).not.toContain('Selected region')
    expect(trimmed).not.toContain('Model:')
    expect(trimmed).toContain('Harbor')
    expect(trimmed).toContain('Left out by the user: model, prompt')
  })
})

describe('CollabPanel', () => {
  function mount(node: React.ReactNode): HTMLElement {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(createElement(ToastProvider, null, node)))
    return host
  }

  it('keeps an SVG attachment removable but offers zoom only on raster thumbnails', async () => {
    function Tray() {
      return createElement(AttachmentTray, { state: useAttachments() })
    }
    const view = mount(createElement('div', null, createElement(Tray), createElement(ImageLightbox)))
    const input = view.querySelector('input[type="file"]')!
    Object.defineProperty(input, 'files', {
      value: [new File(['<svg/>'], 'vector.svg', { type: 'image/svg+xml' }), new File(['photo'], 'photo.png', { type: 'image/png' })],
    })
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    const svg = view.querySelector('[data-attachment="vector.svg"]')!
    expect(svg.querySelector('img')?.alt).toBe('vector.svg')
    expect(svg.querySelector('button[aria-label^="放大预览"]')).toBeNull()
    act(() => view.querySelector<HTMLButtonElement>('[aria-label="放大预览：photo.png"]')!.click())
    expect(document.querySelector<HTMLImageElement>('dialog img')?.src).toBe(
      view.querySelector<HTMLImageElement>('img[alt="photo.png"]')!.src,
    )
    expect(document.querySelector('dialog h2')?.textContent).toBe('photo.png')
    act(() => document.querySelector<HTMLButtonElement>('dialog [aria-label="关闭"]')!.click())
    act(() => svg.querySelector<HTMLButtonElement>('[aria-label="移除图片 vector.svg"]')!.click())
    expect(view.querySelector('[data-attachment="vector.svg"]')).toBeNull()
  })

  it('copies the checked image edit pack only while its live opt-in is on', async () => {
    const backend = createMockBackend(withExternalAgents())
    backend.install()
    localStorage.setItem('mossstudio.collab.toolProfile', 'custom')
    localStorage.setItem('mossstudio.collab.toolPacks', '["image.edit"]')
    const previous = useApp.getState().settings
    const settings = settingsFixture({ externalAgentsEnabled: true, externalImageEditEnabled: true })
    useApp.setState({ settings })
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    try {
      const view = mount(
        createElement(CollabPanel, {
          board: { projectId: 'p', projectName: 'P', canvas: null },
          projectKey: 1,
          visible: true,
          onStandalone: () => {},
        }),
      )
      await settle()
      act(() => view.querySelector<HTMLButtonElement>('[data-tool-packs]')!.click())
      const copySkill = () => act(async () => document.querySelector<HTMLButtonElement>('[data-copy-workbench-skill]')!.click())
      await copySkill()
      expect(copy.mock.lastCall?.[0]).toContain('image.edit.run')
      act(() => useApp.setState({ settings: { ...settings, externalImageEditEnabled: false } }))
      await copySkill()
      expect(copy.mock.lastCall?.[0]).not.toContain('image.edit.run')
      act(() => useApp.setState({ settings: { ...settings, externalAgentsEnabled: false } }))
      await copySkill()
      expect(copy.mock.lastCall?.[0]).not.toContain('image.edit.run')
    } finally {
      copy.mockRestore()
      act(() => useApp.setState({ settings: previous }))
    }
  })

  it('shows the compact header, connects an ACP Agent and switches to the built-in assistant', async () => {
    const backend = createMockBackend(withExternalAgents())
    backend.install()
    backend.handle(Ipc.agentHubBackends, () => [
      { id: 'codex-acp', label: 'Codex ACP', kind: 'acp', available: true, connected: false },
      { id: 'custom-acp', label: '自定义 ACP', kind: 'acp', available: true, connected: false },
    ])
    backend.handle(Ipc.agentHubConnect, (payload) => ({
      id: (payload as { backendId: string }).backendId,
      label: 'Codex ACP',
      available: true,
      connected: true,
    }))
    backend.handle(Ipc.agentHubSessions, () => [])
    backend.handle(Ipc.agentHubApprovals, () => [])
    backend.handle(Ipc.mcpInfo, () => ({ running: true, toolCount: 42, profile: 'compact' }))
    let standalone = 0
    const view = mount(
      createElement(CollabPanel, {
        board: { projectId: 'p', projectName: 'P', canvas: null },
        projectKey: 1,
        visible: true,
        onStandalone: () => standalone++,
      }),
    )
    await settle()
    const header = view.querySelector('[data-collab-header]')!
    expect(header.querySelector('[data-mcp-wizard]')?.textContent).toContain('接入')
    expect(header.querySelector('[data-stats-toggle]')?.textContent).toContain('数据')
    expect(view.querySelector('[data-collab-status]')?.textContent).toContain('MCP · 42')
    expect(view.querySelector('[data-agent-switcher]')?.getAttribute('data-agent-switcher')).toBe('codex-acp')

    const connect = [...view.querySelectorAll('[data-hub-connect="codex-acp"] button')].find((button) =>
      button.textContent?.includes('连接'),
    )
    await act(async () => (connect as HTMLButtonElement).click())
    await settle()
    expect(backend.callsTo(Ipc.agentHubConnect)).toEqual([{ backendId: 'codex-acp' }])
    expect(view.textContent).toContain('还没有对话')

    await act(async () => (view.querySelector('[data-standalone-assistant]') as HTMLButtonElement).click())
    expect(standalone).toBe(1)
  })

  it('preserves Codex restrictions on cancel and only sends reset consent from the confirmation dialog', async () => {
    const state = scenario('externalAgents')
    const codex = state.agents.clients.find((client) => client.id === 'codex')!
    codex.state = 'custom_policy'
    codex.detail = 'Codex 已禁用此服务，未自动覆盖。'
    const backend = createMockBackend(state)
    backend.install()
    mount(
      createElement(McpConnectDialog, {
        open: true,
        onClose: () => {},
        client: createCollabClient(),
        profile: { mode: 'compact', packs: [] },
      }),
    )
    await settle()
    const click = async (button: Element | null | undefined) => act(async () => (button as HTMLButtonElement).click())
    const reconnect = document.querySelector('[data-mcp-install="codex"]')
    expect(reconnect?.textContent).toBe('重新连接')
    const confirming = () => [...document.querySelectorAll('dialog[open]')].find((el) => el.textContent?.includes('清除工具限制'))
    const button = (label: string) => [...(confirming()?.querySelectorAll('button') ?? [])].find((item) => item.textContent === label)
    await click(reconnect)
    await click(button('取消'))
    expect(backend.callsTo(Ipc.mcpClientInstall)).toEqual([])
    await click(reconnect)
    await click(button('重置并重新连接'))
    await settle()
    expect(backend.callsTo(Ipc.mcpClientInstall)).toEqual([{ clientId: 'codex', resetPolicy: true }])
    expect(document.querySelector('[data-mcp-client="codex"]')?.getAttribute('data-mcp-client-state')).toBe('configured')
  })

  it('shows only this project conversations and imports another one by working folder first', async () => {
    const backend = createMockBackend(withExternalAgents())
    backend.install()
    backend.handle(Ipc.agentHubBackends, () => [{ id: 'codex-acp', label: 'Codex ACP', kind: 'acp', available: true, connected: true }])
    backend.handle(Ipc.agentHubSessions, () => [
      { id: 's1', title: '海报一', cwd: 'F:\\work\\poster', updatedAt: 3 },
      { id: 's2', title: '海报二', cwd: 'F:/work/poster/', updatedAt: 2 },
      { id: 's3', title: '漫画', cwd: 'F:\\work\\comic', updatedAt: 9 },
    ])
    bindSession('codex-acp', 'p', 's1')
    const view = mount(
      createElement(CollabPanel, {
        board: { projectId: 'p', projectName: 'P', canvas: null },
        projectKey: 1,
        visible: true,
        onStandalone: () => {},
      }),
    )
    await settle()
    const trigger = (): HTMLButtonElement => view.querySelector('[data-session-trigger]') as HTMLButtonElement
    const ids = (selector: string, attr: string): Array<string | null> =>
      [...view.querySelectorAll(selector)].map((node) => node.getAttribute(attr))
    expect(trigger().getAttribute('data-session-trigger')).toBe('s1')

    await act(async () => trigger().click())
    expect(ids('[data-project-session]', 'data-project-session')).toEqual(['s1'])
    expect(ids('[data-session-workspace]', 'data-session-workspace')).toEqual(['f:/work/comic', 'f:/work/poster'])
    await act(async () => (view.querySelector('[data-session-workspace="f:/work/poster"]') as HTMLButtonElement).click())
    expect(ids('[data-import-session]', 'data-import-session')).toEqual(['s1', 's2'])
    expect(view.querySelector('[data-import-session="s1"]')?.textContent).toContain('已在项目中')
    await act(async () => (view.querySelector('[data-import-session="s2"]') as HTMLButtonElement).click())
    await settle()
    expect(trigger().getAttribute('data-session-trigger')).toBe('s2')
    expect(readSessionBinding('codex-acp', 'p')).toEqual({ currentId: 's2', pinnedIds: ['s1', 's2'] })

    // The imported conversation stays listed; × only takes it out of this project.
    await act(async () => trigger().click())
    expect(ids('[data-project-session]', 'data-project-session')).toEqual(['s1', 's2'])
    await act(async () => (view.querySelector('[data-session-unbind="s2"]') as HTMLButtonElement).click())
    await settle()
    expect(ids('[data-project-session]', 'data-project-session')).toEqual(['s1'])
    expect(trigger().getAttribute('data-session-trigger')).toBe('s1')
    expect(readSessionBinding('codex-acp', 'p')).toEqual({ currentId: 's1', pinnedIds: ['s1'] })
    expect(ids('[data-session-workspace]', 'data-session-workspace')).toEqual(['f:/work/comic', 'f:/work/poster'])
  })

  function mountWithFolders(onCreateProject?: (name: string) => Promise<string | null>) {
    const backend = createMockBackend(withExternalAgents())
    backend.install()
    backend.handle(Ipc.agentHubBackends, () => [{ id: 'codex-acp', label: 'Codex ACP', kind: 'acp', available: true, connected: true }])
    backend.handle(Ipc.agentHubSessions, () => [
      { id: 's1', title: '海报一', cwd: 'F:\\work\\poster', updatedAt: 3 },
      { id: 's3', title: '漫画', cwd: 'F:\\work\\comic', updatedAt: 9 },
      { id: 's4', title: '无目录', updatedAt: 12 },
    ])
    bindSession('codex-acp', 'p', 's1')
    const view = mount(
      createElement(CollabPanel, {
        board: { projectId: 'p', projectName: 'P', canvas: null },
        projectKey: 1,
        visible: true,
        onStandalone: () => {},
        projects: [
          { id: 'p', name: 'P' },
          { id: 'q', name: '漫画集' },
        ],
        onCreateProject,
      }),
    )
    return { backend, view }
  }
  const dialog = (): HTMLFormElement => document.querySelector('[data-new-session-form]') as HTMLFormElement
  const submitButton = (): HTMLButtonElement => document.querySelector('[data-new-session-submit]') as HTMLButtonElement

  it('starts a conversation in a folder the Agent already used and ties it to another canvas project', async () => {
    const { backend, view } = mountWithFolders()
    await settle()
    await act(async () => (view.querySelector('[data-session-create]') as HTMLButtonElement).click())
    await settle()
    expect(dialog().querySelector('[data-workspace-mode]')?.getAttribute('data-workspace-mode')).toBe('existing')
    const select = dialog().querySelector('[data-workspace-select]') as HTMLSelectElement
    // Folders newest first; the conversation without a folder offers none.
    expect([...select.options].map((option) => option.value)).toEqual(['', 'F:\\work\\comic', 'F:\\work\\poster'])
    expect(select.value).toBe('F:\\work\\poster')
    expect(select.options[1]!.textContent).toBe('comic · F:\\work\\comic')
    fill(select, 'F:\\work\\comic')
    expect((dialog().querySelector('[data-workspace-cwd]') as HTMLInputElement).value).toBe('F:\\work\\comic')
    const projectSelect = dialog().querySelector('[data-project-select]') as HTMLSelectElement
    expect([...projectSelect.options].map((option) => option.textContent)).toEqual(['当前项目：P', '漫画集', '不关联'])
    fill(projectSelect, 'q')
    await act(async () => submitButton().click())
    await settle()
    expect(backend.callsTo(Ipc.agentHubCreateSession)).toEqual([{ backendId: 'codex-acp', cwd: 'F:\\work\\comic', projectId: 'q' }])
    expect(readSessionBinding('codex-acp', 'q').pinnedIds).toEqual(['fixture-agent-session'])
    // Made for 漫画集, so it is listed there and not pinned to the open project as well (A-L5).
    expect(readSessionBinding('codex-acp', 'p').pinnedIds).toEqual(['s1'])
  })

  it('creates a new project folder and a new canvas project for the conversation', async () => {
    const created: string[] = []
    const { backend, view } = mountWithFolders(async (name) => {
      created.push(name)
      return 'p-new'
    })
    await settle()
    await act(async () => (view.querySelector('[data-session-create]') as HTMLButtonElement).click())
    await settle()
    const modeButton = [...dialog().querySelectorAll('button')].find((button) => button.textContent === '创建新项目')!
    await act(async () => modeButton.click())
    expect(dialog().querySelector('[data-workspace-mode]')?.getAttribute('data-workspace-mode')).toBe('create')
    // The parent of the current conversation's folder is suggested.
    expect((dialog().querySelector('[data-new-project-parent]') as HTMLInputElement).value).toBe('F:\\work')
    const preview = (): Element => dialog().querySelector('[data-new-project-path]')!
    expect(submitButton().disabled).toBe(true)
    fill(dialog().querySelector('[data-new-project-name]'), 'bad:name')
    expect(preview().textContent).toContain('文件夹名不能包含')
    expect(submitButton().disabled).toBe(true)
    fill(dialog().querySelector('[data-new-project-name]'), 'harbor')
    expect(preview().getAttribute('data-new-project-path')).toBe('F:\\work\\harbor')
    expect(preview().textContent).toBe('将创建：F:\\work\\harbor')
    fill(dialog().querySelector('[data-project-select]'), '__new__')
    expect(submitButton().disabled).toBe(true)
    fill(dialog().querySelector('[data-new-canvas-project]'), '港口')
    expect(submitButton().disabled).toBe(false)
    await act(async () => submitButton().click())
    await settle()
    expect(created).toEqual(['港口'])
    expect(backend.callsTo(Ipc.agentHubCreateSession)).toEqual([
      { backendId: 'codex-acp', cwd: 'F:\\work\\harbor', createCwd: true, projectId: 'p-new' },
    ])
    expect(readSessionBinding('codex-acp', 'p-new').pinnedIds).toEqual(['fixture-agent-session'])
  })

  it('renders only embedded raster pictures in an Agent reply, not remote URLs or filesystem paths', async () => {
    const { backend, view } = mountWithFolders()
    const data = 'data:image/png;base64,iVBORw0KGgo='
    backend.handle(Ipc.agentHubMessages, () => ({
      messages: [
        {
          seq: 1,
          role: 'assistant',
          text: `![image](${data}) ![remote](https://remote.invalid/p.png) ![file](file:///secret/p.png) ![svg](data:image/svg+xml;base64,AAAA)`,
        },
      ],
    }))
    await settle()
    const log = view.querySelector('[role="log"]')!
    expect([...log.querySelectorAll('img')].map((el) => el.getAttribute('src'))).toEqual([data])
    expect(log.querySelector('img')?.closest('button')).not.toBeNull()
  })

  it('does not pick a conversation of another folder for a project that has none', async () => {
    const backend = createMockBackend(withExternalAgents())
    backend.install()
    backend.handle(Ipc.agentHubBackends, () => [{ id: 'codex-acp', label: 'Codex ACP', kind: 'acp', available: true, connected: true }])
    backend.handle(Ipc.agentHubSessions, () => [{ id: 'other', title: '别处', cwd: 'F:\\elsewhere', updatedAt: 5, running: true }])
    const view = mount(
      createElement(CollabPanel, {
        board: { projectId: 'p', projectName: 'P', canvas: null },
        projectKey: 1,
        visible: true,
        onStandalone: () => {},
      }),
    )
    await settle()
    expect(view.querySelector('[data-session-trigger]')?.getAttribute('data-session-trigger')).toBe('')
    expect(view.textContent).toContain('这个项目还没有对话')
    expect(readSessionBinding('codex-acp', 'p').pinnedIds).toEqual([])
  })

  it('answers an external request from the app-wide overlay while no panel shows it inline', async () => {
    const backend = createMockBackend(withExternalAgents())
    backend.install()
    backend.handle(Ipc.agentHubApprovals, () => ({
      pending: [
        {
          id: 'ap1',
          actionId: 'studio.cards.delete',
          packId: 'studio.board.cards',
          title: '删除',
          summary: '删除 画面 1',
          argsPreview: '{}',
          source: 'external-agent',
          createdAt: 't',
        },
      ],
    }))
    backend.handle(Ipc.agentHubResolveApproval, () => true)
    const view = mount(createElement(GlobalApprovalOverlay))
    await settle()
    const overlay = view.querySelector('[data-global-approval-overlay]')
    expect(overlay?.textContent).toContain('删除 画面 1')
    await act(async () => (overlay!.querySelector('[data-approval-approve]') as HTMLButtonElement).click())
    await settle()
    expect(backend.callsTo(Ipc.agentHubResolveApproval)).toEqual([{ id: 'ap1', decision: 'approve' }])
    expect(view.querySelector('[data-global-approval-overlay]')).toBeNull()
  })

  it('stops claiming an Agent is connected once its connection drops, and offers the one step back', async () => {
    const backend = createMockBackend(withExternalAgents())
    backend.install()
    backend.handle(Ipc.agentHubBackends, () => [
      {
        id: 'codex-acp',
        label: 'Codex ACP',
        kind: 'acp',
        available: true,
        connected: backend.state.agents.sendError === undefined,
      },
    ])
    backend.handle(Ipc.agentHubSessions, () => [{ id: 's1', title: '海报一', cwd: 'F:\\work\\poster', updatedAt: 3 }])
    backend.handle(Ipc.agentHubMessages, () => ({ messages: [], hasMore: false, asOfSeq: 0 }))
    backend.handle(Ipc.agentHubConnect, () => ({ id: 'codex-acp', label: 'Codex ACP', kind: 'acp', available: true, connected: true }))
    bindSession('codex-acp', 'p', 's1')
    const view = mount(
      createElement(CollabPanel, {
        board: { projectId: 'p', projectName: 'P', canvas: null },
        projectKey: 1,
        visible: true,
        onStandalone: () => {},
      }),
    )
    await settle()
    expect(view.querySelector('[data-collab-status]')?.getAttribute('data-activity')).toBe('idle')
    expect(view.querySelector('[data-collab-reconnect]')).toBeNull()

    // The Agent's process exited: sending fails the way the hub reports it.
    const asked = backend.callsTo(Ipc.agentHubBackends).length
    backend.state.agents.sendError = 'Agent 进程已退出'
    fill(view.querySelector('textarea[aria-label="发给 Codex 的消息"]'), '你好')
    const send = [...view.querySelectorAll('button')].find((button) => button.textContent === '发给 Codex')!
    await act(async () => (send as HTMLButtonElement).click())
    await settle()

    // The warning is shown, the hub is asked again, and the status bar stops lying.
    expect(view.querySelector('[data-notice="warn"]')?.textContent).toContain('Agent 进程已退出')
    expect(backend.callsTo(Ipc.agentHubBackends).length).toBe(asked + 1)
    expect(view.querySelector('[data-collab-status]')?.getAttribute('data-activity')).toBe('offline')

    // One click brings it back, without hunting for the Agent switcher.
    await act(async () => (view.querySelector('[data-collab-reconnect]') as HTMLButtonElement).click())
    await settle()
    expect(backend.callsTo(Ipc.agentHubConnect)).toEqual([{ backendId: 'codex-acp' }])
    expect(view.querySelector('[data-notice="warn"]')).toBeNull()
  })

  it('leaves a dropped custom command to its connect card, which holds its arguments', async () => {
    const backend = createMockBackend(withExternalAgents())
    backend.install()
    const custom = { id: 'custom-acp', label: '自定义 ACP', kind: 'acp', available: true, command: 'npx' }
    backend.handle(Ipc.agentHubBackends, () => [{ ...custom, connected: backend.state.agents.sendError === undefined }])
    backend.handle(Ipc.agentHubSessions, () => [{ id: 's1', title: '海报一', cwd: 'F:\\work\\poster', updatedAt: 3 }])
    backend.handle(Ipc.agentHubMessages, () => ({ messages: [], hasMore: false, asOfSeq: 0 }))
    bindSession('custom-acp', 'p', 's1')
    const view = mount(
      createElement(CollabPanel, {
        board: { projectId: 'p', projectName: 'P', canvas: null },
        projectKey: 1,
        visible: true,
        onStandalone: () => {},
      }),
    )
    await settle()
    backend.state.agents.sendError = 'Agent 进程已退出'
    fill(view.querySelector('textarea'), '你好')
    const send = [...view.querySelectorAll('button')].find((button) => button.textContent?.startsWith('发给'))!
    await act(async () => (send as HTMLButtonElement).click())
    await settle()
    expect(view.querySelector('[data-notice="warn"]')?.textContent).toContain('Agent 进程已退出')
    expect(view.querySelector('[data-collab-reconnect]')).toBeNull()
    expect(view.querySelector('[data-hub-connect="custom-acp"]')).not.toBeNull()
  })

  it('tells a refused request apart from a dropped connection, so only the second offers a reconnect', () => {
    // A driver's code decides when it names a lost connection (the DSH Desktop driver's E_DSH_DISCONNECTED).
    expect(connectionLost(new ApiError({ code: 'E_DSH_DISCONNECTED', message: 'x' }))).toBe(true)
    // The DSH Desktop driver's drop as a stream error, and a request it refused.
    expect(connectionLost(new ApiError({ code: 'E_AGENT_STREAM', message: 'DSH 消息流已中断，请重新连接' }))).toBe(true)
    expect(connectionLost(new ApiError({ code: 'E_DSH_RPC', message: 'DSH 没有接受这个请求，请检查会话、模型及桌面端状态' }))).toBe(false)
    // The ACP driver's messages, which main sends as INTERNAL or as a stream error.
    for (const message of [
      'Agent 已断开连接',
      'Agent 进程已退出',
      'Agent 输入通道已关闭',
      'Agent 尚未连接，请先连接后端',
      'Agent 请求超时，请重新连接',
    ]) {
      expect(connectionLost(new ApiError({ code: 'INTERNAL', message }))).toBe(true)
      expect(connectionLost(new ApiError({ code: 'E_AGENT_STREAM', message }))).toBe(true)
    }
    expect(connectionLost(new ApiError({ code: 'E_AGENT_STREAM', message: 'Agent 这次没有回复成功，请稍后重试。' }))).toBe(false)
    expect(connectionLost(new Error('无法启动 Agent，请检查命令是否已安装'))).toBe(false)
    expect(connectionLost(new Error('这个 Agent 暂时不能切换模型'))).toBe(false)
    expect(connectionLost(undefined)).toBe(false)
  })
})
