import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
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
import { MAX_ATTACHMENT_BYTES, planAttachments } from '@renderer/pages/studio/assistant/AttachmentTray'
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
import { CollabPanel, agentShortName } from '@renderer/pages/studio/assistant/CollabPanel'
import { capabilityLabel, contextChips, formatBoardContext } from '@renderer/pages/studio/assistant/collabContext'
import { GlobalApprovalOverlay } from '@renderer/pages/studio/assistant/GlobalApprovalOverlay'
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
  const proto = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
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

  it('offers Codex CLI and Claude Code only, in a fixed order', () => {
    const clients = normalizeMcpClients({ clients: [{ id: 'claude-code', installed: true, configPath: '/c' }, { id: 'other' }] })
    expect(clients.map((item) => [item.id, item.installed])).toEqual([
      ['codex', false],
      ['claude-code', true],
    ])
    const config = JSON.parse(
      mcpConfigJson({ url: 'http://127.0.0.1:1/mcp', token: 't', toolCount: 3, discoveryPath: '/d.json', stdioBridgePath: '/b.js' }, 'all'),
    ) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(config.mcpServers)).toEqual(['mossstudio', 'mossstudio-stdio'])
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
    // 14 MossStudio packs plus the shared remote.hosts pack.
    expect(listPackRows()).toHaveLength(15)
    expect(listPackRows().map((row) => row.id)).toContain('remote.hosts')
    expect(effectivePacks({ mode: 'compact', packs: [] })).toEqual(COMPACT_PACKS)
    const next = togglePack({ mode: 'compact', packs: [] }, 'studio.ask')
    expect(next.mode).toBe('custom')
    expect(next.packs).not.toContain('studio.ask')
    expect(next.packs).toHaveLength(COMPACT_PACKS.length - 1)
    expect(togglePack({ mode: 'atomic', packs: [] }, 'training.jobs').packs).toHaveLength(14)
    expect(toolProfileLine({ mode: 'custom', packs: ['studio.ask'] })).toBe('Tools allowed: studio.ask')
    expect(toolProfileLine({ mode: 'atomic', packs: [] })).toBe('Tools allowed: the atomic set')
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
})
