import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defaultUrlTransform, type MarkdownProps } from '@openai/apps-sdk-ui/components/Markdown'
import { BarChart3, Loader2, Plug, Square } from 'lucide-react'
import type { AgentProject } from '@shared/agentHub'
import { PreviewButton, isRasterData } from '../../../components/common/ImageLightbox'
import { Notice } from '../../../components/common/Notice'
import { DesktopSessionBar, useWorkspaceChoice } from './DesktopSessionBar'
import { Button, cn, EmptyState, Field, FieldLabel, Input, LoadingRow, MarkdownBody, Textarea } from '../../../components/ui'
import { ApiError } from '../../../lib/api'
import { AgentSessionBar, AgentSwitcher, type AgentAction } from './AgentBackendBar'
import { ApprovalDock, useApprovals, useInlineApprovalDock } from './ApprovalDock'
import { AttachmentTray, imageFilesOf, useAttachments } from './AttachmentTray'
import { CollabStatusBar, type CollabActivity } from './CollabStatusBar'
import { CollabToolbar, toolProfileLine, useToolProfile, type ToolProfileState } from './CollabToolbar'
import { McpConnectDialog } from './McpConnectDialog'
import {
  chooseSession,
  createCollabClient,
  FALLBACK_BACKENDS,
  isCustomBackend,
  sanitizeMessageText,
  type AgentBackendInfo,
  type AgentHubStreamEvent,
  type AgentMessage,
  type AgentMessagePage,
  type AgentSession,
  type CollabAttachment,
  type CollabClient,
  type CollabCreateSessionInput,
} from './collabClient'
import {
  capabilityLabel,
  contextChips,
  formatBoardContext,
  type CollabBoardContext,
  type ContextFilter,
  type ContextPart,
} from './collabContext'
import { ContextChips } from './ContextChips'
import { ModelPicker, type ModelState } from './ModelPicker'
import { NewSessionDialog, type CanvasProjectOption, type WorkspaceOption } from './NewSessionDialog'
import {
  adoptSessionBinding,
  bindNewSession,
  bindSession,
  groupByWorkspace,
  projectSessions,
  readSessionBinding,
  unbindSession,
  type ProjectSessionBinding,
} from './sessionBindings'
import { SessionStatsPanel } from './SessionStats'
import { mergeSteps, StepProgressDock, type ProgressStep } from './StepProgressDock'

// Reply text is untrusted: show embedded raster data, never load a URL or open a path named by the Agent.
export const replyImages: Pick<MarkdownProps, 'urlTransform' | 'components'> = {
  urlTransform: (url, key) => (key === 'src' ? (isRasterData(url) ? url : '') : defaultUrlTransform(url)),
  components: {
    img: ({ node }) => {
      const src = (node.properties as { src?: string } | undefined)?.src
      return src && isRasterData(src) ? (
        <PreviewButton path={src} title="回复图片" className="h-auto">
          <img src={src} alt="回复图片" />
        </PreviewButton>
      ) : (
        <span>外部图片未加载</span>
      )
    },
  },
}

const BACKEND_KEY = 'mossstudio.collab.backend'
const POLL_MS = 2000
const SESSIONS_POLL_MS = 10_000
const NO_PROJECTS: readonly CanvasProjectOption[] = []
/** What an Agent says when its connection is gone rather than the request being wrong. */
const LOST_CODES = /DISCONNECT|NOT_CONNECTED|NO_CONNECTION|CONNECTION_LOST/
// The ACP driver's own messages (acpDriver.ts) carry no code. It also ends the Agent when a request times out.
const LOST_WORDS =
  /连接已断开|已断开连接|进程已退出|输入通道已关闭|尚未连接|请先连接|消息流已中断|连接中断|请求超时|not connected|disconnected/i

/**
 * Whether a failure means "the Agent is no longer connected", which the panel
 * can fix by reconnecting, or just "this request was refused", which it cannot.
 * A code that names a lost connection decides; otherwise the wording does. That
 * includes a failed turn (`E_AGENT_STREAM`), whose message is the driver's: a
 * reply that merely failed offers no reconnect, an exited process does.
 */
export function connectionLost(reason: unknown): boolean {
  if (!reason) return false
  if (typeof reason === 'string') return LOST_WORDS.test(reason)
  const error = reason as { code?: unknown; message?: unknown }
  if (typeof error.code === 'string' && LOST_CODES.test(error.code)) return true
  return typeof error.message === 'string' && LOST_WORDS.test(error.message)
}

function readBackend(): string {
  try {
    return localStorage.getItem(BACKEND_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeBackend(id: string): void {
  try {
    localStorage.setItem(BACKEND_KEY, id)
  } catch {
    // Remembering the backend is a convenience only.
  }
}

function sessionsSignature(items: readonly AgentSession[]): string {
  return items.map((s) => `${s.id}|${s.title}|${s.agentPreset ?? ''}|${s.model ?? ''}|${s.cwd ?? ''}|${s.running ? 1 : 0}`).join('\n')
}

function messagesSignature(items: readonly AgentMessage[]): string {
  return items
    .map(
      (m) =>
        `${m.seq}:${m.role}:${m.text.length}:${m.text.slice(-24)}:${m.images?.map((i) => `${i.length}:${i.slice(-24)}`).join('|') ?? ''}`,
    )
    .join('\n')
}

/** A slow Agent must not pile up polls, and a late answer belongs only to the panel that asked. */
function usePoll<T>(
  read: () => Promise<T>,
  apply: (value: T) => void,
  fail: (error: unknown) => void,
  enabled = true,
  intervalMs = POLL_MS,
): () => void {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try {
        const value = await read()
        if (active) apply(value)
      } catch (error) {
        if (active) fail(error)
      } finally {
        if (active) timer = setTimeout(() => void poll(), intervalMs)
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [read, apply, fail, enabled, intervalMs, revision])
  return useCallback(() => setRevision((n) => n + 1), [])
}

interface ChatStatus {
  model?: string
  cwd?: string
  activity: CollabActivity
}

/** How one Agent's conversations are named and written to. */
interface ChatBackend {
  id: string
  label: string
  /** Short name in bubbles and buttons: Codex, Claude… */
  name: string
  send: (input: {
    session: AgentSession
    text: string
    studioContext: string
    profile: ToolProfileState
    attachments: CollabAttachment[]
  }) => Promise<void>
}

/** `Codex ACP` → `Codex`: the name a person calls the Agent by. */
export function agentShortName(label: string): string {
  const short = label.replace(/\s*\(?\bACP\b\)?\s*/gi, ' ').trim()
  return short || label
}

/** What every pane shares with the conversation inside it. */
interface ChatShared {
  client: CollabClient
  board: CollabBoardContext
  profile: ToolProfileState
  statsOpen: boolean
  mcpToolCount: number | null
  dock: React.ReactNode
  /** The toolset control, at the end of the session row (or alone while not connected). */
  toolbar: React.ReactNode
  onConnectionActions: (actions: AgentAction[]) => void
  onError: (reason: unknown) => void
  onClearError: () => void
  onStatus: (status: ChatStatus) => void
  /** Every saved Studio project, offered when a new conversation is tied to one. */
  projects: readonly CanvasProjectOption[]
  onCreateProject?: (name: string) => Promise<string | null>
}

/**
 * The 协同 panel: talk to an ACP Agent (Codex, or any ACP command) that works
 * on this board through the local MCP tools. A compact two-line header picks
 * the Agent and its conversation; approvals, progress and the model sit by the
 * message box.
 */
export function CollabPanel({
  board,
  projectKey,
  visible,
  onStandalone,
  projects = NO_PROJECTS,
  onCreateProject,
}: {
  board: CollabBoardContext
  /** Changes when another project opens, so the conversation follows the project. */
  projectKey: number
  visible: boolean
  /** Switch to the built-in assistant. */
  onStandalone: () => void
  projects?: readonly CanvasProjectOption[]
  /** Saves a new, empty Studio project and returns its id. */
  onCreateProject?: (name: string) => Promise<string | null>
}): React.JSX.Element {
  const client = useMemo(() => createCollabClient(), [])
  const [backends, setBackends] = useState<AgentBackendInfo[]>(() => FALLBACK_BACKENDS.map((item) => ({ ...item })))
  const [backendId, setBackendId] = useState(readBackend)
  const [refreshing, setRefreshing] = useState(false)
  const [profile, setProfile] = useToolProfile(client)
  const [statsOpen, setStatsOpen] = useState(false)
  const [mcpToolCount, setMcpToolCount] = useState<number | null>(null)
  const [chatStatus, setChatStatus] = useState<ChatStatus>({ activity: 'idle' })
  const [error, setError] = useState('')
  const [wizardOpen, setWizardOpen] = useState(false)
  const [connectionActions, setConnectionActions] = useState<AgentAction[]>([])
  const approvals = useApprovals(client, visible)
  useInlineApprovalDock(visible)

  const loadBackends = useCallback(async () => {
    setRefreshing(true)
    try {
      setBackends(await client.listBackends())
    } catch {
      // Keep the list on screen.
    } finally {
      setRefreshing(false)
    }
  }, [client])

  useEffect(() => {
    if (visible) void loadBackends()
  }, [visible, loadBackends])

  const packsKey = profile.packs.join(',')
  useEffect(() => {
    if (!visible) return
    let active = true
    void client.mcpSummary().then((summary) => {
      if (active) setMcpToolCount(summary?.running ? summary.toolCount : null)
    })
    return () => {
      active = false
    }
  }, [client, visible, profile.mode, packsKey])

  const backend =
    backends.find((item) => item.id === backendId) ?? backends.find((item) => item.preferred) ?? backends[0] ?? FALLBACK_BACKENDS[0]!

  const [lost, setLost] = useState(false)
  const fail = useCallback(
    (reason: unknown) => {
      setError(reason instanceof Error && reason.message ? reason.message : '无法连接 Agent，请确认它仍在运行后重试。')
      // An Agent whose connection dropped is no longer connected: the head, the
      // status bar and the connect card must stop claiming it is.
      const dropped = connectionLost(reason)
      setLost(dropped)
      if (dropped) void loadBackends()
    },
    [loadBackends],
  )
  const clearError = useCallback(() => setError(''), [])

  const [reconnecting, setReconnecting] = useState(false)
  const backendIdRef = useRef(backend.id)
  backendIdRef.current = backend.id
  /** The one step back after a drop, without hunting for the Agent switcher. */
  const reconnect = useCallback(async () => {
    if (reconnecting) return
    setReconnecting(true)
    try {
      const id = backendIdRef.current
      const info = await client.connect({ backendId: id })
      setBackends((list) => list.map((item) => (item.id === id ? (info ?? { ...item, connected: true }) : item)))
      setError('')
    } catch (reason) {
      fail(reason)
    } finally {
      setReconnecting(false)
    }
  }, [client, fail, reconnecting])
  // A custom command's arguments live only in its connect card, so it reconnects from there.
  const mayReconnect = lost && !isCustomBackend(backend)

  const dock = (
    <ApprovalDock
      pending={approvals.pending}
      resolving={approvals.resolving}
      onResolve={(id, decision) => void approvals.resolve(id, decision)}
    />
  )
  const toolbar = <CollabToolbar client={client} profile={profile} onProfileChange={setProfile} onOpenWizard={() => setWizardOpen(true)} />
  const shared: ChatShared = {
    client,
    board,
    profile,
    statsOpen,
    mcpToolCount,
    dock,
    toolbar,
    onConnectionActions: setConnectionActions,
    onError: fail,
    onClearError: clearError,
    onStatus: setChatStatus,
    projects,
    onCreateProject,
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5" data-collab-panel>
      <div className="flex min-w-0 items-center gap-1" data-collab-header>
        <div className="flex min-w-0 flex-1">
          <AgentSwitcher
            backends={backends}
            selectedId={backend.id}
            refreshing={refreshing}
            actions={connectionActions}
            onRefresh={() => void loadBackends()}
            onSelect={(id) => {
              if (id !== backend.id) setConnectionActions([])
              setBackendId(id)
              writeBackend(id)
              setError('')
              setChatStatus({ activity: 'idle' })
            }}
          />
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            tone="ghost"
            size="xs"
            className="px-1.5"
            title="接入 Codex 或 Claude Code"
            data-mcp-wizard
            onClick={() => setWizardOpen(true)}
          >
            <Plug className="size-3" aria-hidden="true" strokeWidth={1.6} />
            接入
          </Button>
          <Button
            tone="ghost"
            size="xs"
            className={cn('px-1.5', statsOpen && 'bg-well-strong')}
            aria-pressed={statsOpen}
            title="会话的模型、用量和最近工具调用"
            data-stats-toggle
            onClick={() => setStatsOpen((open) => !open)}
          >
            <BarChart3 className="size-3" aria-hidden="true" strokeWidth={1.6} />
            数据
          </Button>
          <Button tone="ghost" size="xs" className="px-1.5" title="切换到内置助手" data-standalone-assistant onClick={onStandalone}>
            独立助手
          </Button>
        </div>
      </div>
      <McpConnectDialog open={wizardOpen} onClose={() => setWizardOpen(false)} client={client} profile={profile} />
      {visible ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5">
          <HubPane
            key={backend.id}
            {...shared}
            backend={backend}
            projectKey={projectKey}
            onBackendChange={(next) => setBackends((list) => list.map((item) => (item.id === next.id ? next : item)))}
          />
        </div>
      ) : null}
      {error ? (
        <Notice
          tone="warn"
          action={
            mayReconnect ? (
              <Button data-collab-reconnect size="xs" disabled={reconnecting} onClick={() => void reconnect()}>
                {reconnecting ? '重连中…' : '重新连接'}
              </Button>
            ) : undefined
          }
        >
          {error}
        </Notice>
      ) : null}
      <CollabStatusBar
        backendLabel={backend.label}
        connected={backend.connected}
        cwd={chatStatus.cwd}
        model={chatStatus.model}
        mcpToolCount={mcpToolCount}
        activity={chatStatus.activity}
      />
    </div>
  )
}

/** An ACP Agent (Codex or a custom command) reached through the hub. */
function HubPane({
  backend,
  projectKey,
  onBackendChange,
  ...shared
}: ChatShared & { backend: AgentBackendInfo; projectKey: number; onBackendChange: (next: AgentBackendInfo) => void }): React.JSX.Element {
  const { client, onError, onClearError, dock, toolbar, onConnectionActions } = shared
  const [busy, setBusy] = useState(false)
  const [command, setCommand] = useState(backend.command ?? '')
  const [args, setArgs] = useState('')
  const [pairing, setPairing] = useState('')
  const custom = isCustomBackend(backend)
  // Another DeepSeek Harness on this computer: it pairs with its own local address.
  const desktop = backend.kind === 'dsh-desktop'

  async function connect(): Promise<void> {
    if (busy) return
    setBusy(true)
    onClearError()
    try {
      const customArgs = args.trim() ? args.trim().split(/\s+/) : undefined
      const info = await client.connect({
        backendId: backend.id,
        ...(desktop && pairing.trim() ? { pairingUrl: pairing.trim() } : {}),
        ...(custom && command.trim() ? { customCommand: command.trim() } : {}),
        ...(custom && customArgs ? { customArgs } : {}),
      })
      setPairing('')
      onBackendChange(info ?? { ...backend, connected: true })
    } catch (reason) {
      onError(reason)
    } finally {
      setBusy(false)
    }
  }

  const latestDisconnect = useRef(() => {})
  latestDisconnect.current = () => {
    onClearError()
    void client.disconnect(backend.id).then(
      () => onBackendChange({ ...backend, connected: false }),
      (reason: unknown) => onError(reason),
    )
  }
  useEffect(() => {
    onConnectionActions(backend.connected ? [{ id: 'disconnect', label: '断开连接', run: () => latestDisconnect.current() }] : [])
  }, [backend.connected, onConnectionActions])
  useEffect(() => () => onConnectionActions([]), [onConnectionActions])

  const chat = useMemo<ChatBackend>(
    () => ({
      id: backend.id,
      label: backend.label,
      name: agentShortName(backend.label),
      async send({ session, text, studioContext, profile, attachments }) {
        await client.send({
          backendId: backend.id,
          sessionId: session.id,
          requestId: crypto.randomUUID(),
          text,
          studioContext,
          toolProfile: profile.mode,
          ...(attachments.length ? { attachments } : {}),
        })
      },
    }),
    [client, backend.id, backend.label],
  )

  if (!backend.connected) {
    const ready = backend.available || custom || (desktop && Boolean(pairing.trim()))
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <div className="flex justify-end">{toolbar}</div>
        <div className="flex flex-col gap-2.5 rounded-lg bg-well p-3" data-hub-connect={backend.id}>
          <div className="flex flex-col gap-1">
            <span className="text-ui font-medium text-ink">{backend.label}</span>
            <span className="text-caption text-ink-2 [overflow-wrap:anywhere]">
              {backend.detail ?? (ready ? '' : '没有在这台电脑上找到它，请先安装后点左上角重新检测。')}
            </span>
          </div>
          {desktop ? (
            <Field label={backend.available ? '已发现 · 本机配对地址（可选）' : '本机配对地址'}>
              <Input
                aria-label="本机配对地址"
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={2048}
                value={pairing}
                onChange={(event) => setPairing(event.target.value)}
              />
            </Field>
          ) : null}
          {custom ? (
            <div className="flex flex-col gap-2">
              <Field label="启动命令">
                <Input
                  value={command}
                  maxLength={1024}
                  spellCheck={false}
                  placeholder="例如：npx"
                  onChange={(event) => setCommand(event.target.value)}
                />
              </Field>
              <Field label="参数">
                <Input
                  value={args}
                  maxLength={2048}
                  spellCheck={false}
                  placeholder="例如：-y @zed-industries/codex-acp"
                  onChange={(event) => setArgs(event.target.value)}
                />
              </Field>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button tone="primary" size="sm" disabled={busy || !ready || (custom && !command.trim())} onClick={() => void connect()}>
              {busy ? '连接中…' : `连接 ${backend.label}`}
            </Button>
          </div>
        </div>
        <span className="flex-1" />
        {dock}
      </div>
    )
  }
  return <ProjectChat key={projectKey} {...shared} chat={chat} desktop={desktop} />
}

function ProjectChat({ chat, desktop, ...shared }: ChatShared & { chat: ChatBackend; desktop: boolean }): React.JSX.Element {
  const { client, board, onError, onClearError, onStatus, dock, toolbar, projects, onCreateProject } = shared
  const [sessions, setSessions] = useState<AgentSession[] | null>(null)
  const [binding, setBinding] = useState<ProjectSessionBinding>(() => readSessionBinding(chat.id, board.projectId))
  const [creating, setCreating] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  const [desktopProjects, setDesktopProjects] = useState<AgentProject[]>([])
  const {
    workspaceId,
    sessionId: workspaceSession,
    chooseWorkspace,
    chooseSession: chooseWorkspaceSession,
  } = useWorkspaceChoice(board.projectId)
  const workspace = desktopProjects.find((p) => p.id === workspaceId)
  const listProjects = useCallback(() => client.listProjects(chat.id), [client, chat.id])
  const refreshProjects = usePoll(listProjects, setDesktopProjects, onError, desktop && !newOpen, SESSIONS_POLL_MS)
  const listSessions = useCallback(() => client.listSessions(chat.id), [client, chat.id])
  const applySessions = useCallback((next: AgentSession[]) => {
    setSessions((prev) => (prev && sessionsSignature(prev) === sessionsSignature(next) ? prev : next))
  }, [])
  const refresh = usePoll(listSessions, applySessions, onError, !pickerOpen, SESSIONS_POLL_MS)
  // Only this project's conversations are candidates; the rest are imported from the picker.
  const pinned = useMemo(() => projectSessions(sessions ?? [], binding.pinnedIds), [sessions, binding.pinnedIds])
  const scoped = projectSessions(sessions ?? [], workspace?.sessionIds ?? [])
  const selectedId = desktop ? chooseSession(scoped, workspaceSession) : chooseSession(pinned, binding.currentId)
  const session = sessions?.find((item) => item.id === selectedId)
  const workspaces = useMemo<WorkspaceOption[]>(
    () =>
      groupByWorkspace(sessions ?? [])
        .filter((group) => group.cwd)
        .map((group) => ({ cwd: group.cwd, label: group.label })),
    [sessions],
  )

  const bind = useCallback((sessionId: string) => setBinding(bindSession(chat.id, board.projectId, sessionId)), [chat.id, board.projectId])
  // Saving a new project gives it an id; its conversations move with it.
  const boundProject = useRef(board.projectId)
  const latestBinding = useRef(binding)
  latestBinding.current = binding
  useEffect(() => {
    if (boundProject.current === board.projectId) return
    boundProject.current = board.projectId
    setBinding(adoptSessionBinding(chat.id, board.projectId, latestBinding.current))
  }, [chat.id, board.projectId])
  useEffect(() => {
    if (desktop) {
      if (selectedId && selectedId !== workspaceSession) chooseWorkspaceSession(selectedId)
    } else if (selectedId && selectedId !== binding.currentId) bind(selectedId)
  }, [desktop, workspaceSession, chooseWorkspaceSession, selectedId, binding.currentId, bind])

  useEffect(() => {
    if (!session) onStatus({ activity: 'idle' })
  }, [session, onStatus])

  async function createSession(input: CollabCreateSessionInput): Promise<boolean> {
    if (creating) return false
    onClearError()
    setCreating(true)
    try {
      const id = await client.createSession(chat.id, input)
      // A conversation made for another canvas project is listed there, not here.
      setBinding(bindNewSession(chat.id, board.projectId, input.projectId, id))
      if (desktop) {
        const updated = await listProjects()
        setDesktopProjects(updated)
        const owner = updated.find((p) => p.sessionIds.includes(id))?.id ?? input.workspaceId
        if (owner && (!input.projectId || input.projectId === board.projectId)) chooseWorkspace(owner, id)
      }
      setSessions(await listSessions())
      return true
    } catch (reason) {
      onError(reason)
      return false
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      {desktop ? (
        <DesktopSessionBar
          projects={desktopProjects}
          project={workspace}
          sessions={scoped}
          sessionId={selectedId}
          onProject={chooseWorkspace}
          onSession={chooseWorkspaceSession}
          onCreate={() => setNewOpen(true)}
          onRefresh={() => {
            refreshProjects()
            refresh()
          }}
        />
      ) : null}
      <div className="flex min-w-0 items-center justify-end gap-1" data-session-row>
        {!desktop ? (
          <AgentSessionBar
            label={`${chat.name} 会话`}
            sessions={sessions}
            pinned={pinned}
            selectedId={selectedId}
            creating={creating}
            createLabel="新建对话"
            onOpenChange={setPickerOpen}
            onSelect={(nextId) => {
              onClearError()
              bind(nextId)
            }}
            onUnbind={(id) => {
              onClearError()
              setBinding(unbindSession(chat.id, board.projectId, id))
            }}
            onCreate={() => setNewOpen(true)}
            onRefresh={() => {
              onClearError()
              refresh()
            }}
          />
        ) : null}
        {toolbar}
      </div>
      <NewSessionDialog
        open={newOpen}
        client={client}
        backendId={chat.id}
        backendLabel={chat.label}
        projectId={board.projectId}
        projectName={board.projectName}
        projects={projects}
        workspaces={desktop ? desktopProjects.map((p) => ({ id: p.id, cwd: p.cwd, label: p.title })) : workspaces}
        defaultWorkspaceId={workspace?.id}
        defaultCwd={desktop ? workspace?.cwd : session?.cwd}
        onClose={() => setNewOpen(false)}
        onCreate={createSession}
        onCreateProject={onCreateProject}
      />
      {session ? (
        <SessionChat key={session.id} {...shared} chat={chat} session={session} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5">
          {!sessions ? (
            <LoadingRow label="正在读取会话…" />
          ) : sessions.length ? (
            <EmptyState size="section" title="这个项目还没有对话" />
          ) : (
            <EmptyState size="section" title="还没有对话" />
          )}
          <span className="flex-1" />
          {dock}
        </div>
      )}
    </>
  )
}

interface StreamState {
  text: string
  status: string
  /** The newest message seq when the stream started; a polled reply after it replaces the stream text. */
  baseline: number
}

function lastRunningStep(steps: readonly StreamStep[], name: string | undefined): number {
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index]!
    if (step.status === 'running' && (!name || step.name === name)) return index
  }
  return -1
}

type StreamStep = ProgressStep & { name: string }

const AUDIT_POLL_MS = 2000

function SessionChat({
  chat,
  session,

  client,
  board,
  profile,
  statsOpen,
  mcpToolCount,
  dock,
  onError,
  onStatus,
}: ChatShared & { chat: ChatBackend; session: AgentSession }): React.JSX.Element {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [pageSteps, setPageSteps] = useState<ProgressStep[]>([])
  const [draft, setDraft] = useState('')
  const [operation, setOperation] = useState<'send' | 'stop' | null>(null)
  const [stream, setStream] = useState<StreamState | null>(null)
  const [streamSteps, setStreamSteps] = useState<StreamStep[]>([])
  const [auditSteps, setAuditSteps] = useState<ProgressStep[]>([])
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null)
  /** Sent and not answered yet: the seq the reply must come after. */
  const [waitingAfter, setWaitingAfter] = useState<number | null>(null)
  const [filter, setFilter] = useState<ContextFilter>({})
  const [dragging, setDragging] = useState(false)
  const [modelState, setModelState] = useState<ModelState>({})
  const attachments = useAttachments()
  const active = useRef(true)
  const pending = useRef(false)
  const logRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)
  const lastSeq = useRef(0)
  lastSeq.current = messages.at(-1)?.seq ?? 0

  const read = useCallback(() => client.readMessages(chat.id, session.id), [client, chat.id, session.id])
  const apply = useCallback((page: AgentMessagePage) => {
    setMessages((prev) => (messagesSignature(prev) === messagesSignature(page.messages) ? prev : page.messages))
    setPageSteps((prev) => {
      const next = page.steps ?? []
      return JSON.stringify(prev) === JSON.stringify(next) ? prev : next
    })
  }, [])
  const caughtUp = (after: number): boolean => messages.some((message) => message.role === 'assistant' && message.seq > after)
  // A polled reply after the sent message ends the wait (Agents that never stream answer by polling alone).
  const waiting = waitingAfter !== null && !caughtUp(waitingAfter)
  const busyReply = session.running === true || stream !== null || waiting
  const refresh = usePoll(read, apply, onError, true, busyReply ? 1200 : 3000)

  useEffect(() => {
    active.current = true
    stickBottom.current = true
    return () => {
      active.current = false
    }
  }, [session.id])

  useEffect(() => {
    return client.onStream((event: AgentHubStreamEvent) => {
      if (event.backendId !== chat.id || event.sessionId !== session.id) return
      setWaitingAfter(null)
      setTurnStartedAt((value) => value ?? Date.now())
      if (event.type === 'done' || event.type === 'error') {
        setStream(null)
        const now = Date.now()
        // Whatever was still running ends with the turn.
        setStreamSteps((steps) =>
          steps.map((step) =>
            step.status === 'running'
              ? {
                  ...step,
                  status: event.type === 'error' ? 'error' : 'done',
                  endedAt: now,
                  ...(event.type === 'error' && event.message ? { error: event.message } : {}),
                }
              : step,
          ),
        )
        if (event.type === 'error') {
          onError(new ApiError({ code: 'E_AGENT_STREAM', message: event.message || event.text || 'Agent 这次没有回复成功，请稍后重试。' }))
        }
        refresh()
        return
      }
      if (event.type === 'tool-start') {
        setStreamSteps((steps) => {
          const name = event.toolName ?? '工具'
          const id = event.callId ?? `${name}-${steps.length}`
          return [
            ...steps,
            {
              id,
              name,
              title: capabilityLabel(name),
              status: 'running',
              startedAt: Date.now(),
              ...(event.detail ? { detail: event.detail } : {}),
            },
          ]
        })
      } else if (event.type === 'tool-end') {
        setStreamSteps((steps) => {
          const index = event.callId ? steps.findIndex((step) => step.id === event.callId) : lastRunningStep(steps, event.toolName)
          if (index < 0) return steps
          const next = steps.slice()
          const failed = event.ok === false
          next[index] = {
            ...next[index]!,
            status: failed ? 'error' : 'done',
            endedAt: Date.now(),
            ...(event.detail ? { detail: event.detail } : {}),
            ...(failed ? { error: event.message || event.detail || '这一步没有成功' } : {}),
          }
          return next
        })
      }
      setStream((current) => {
        const base: StreamState = current ?? { text: '', status: '', baseline: lastSeq.current }
        if (event.type === 'delta') return { ...base, text: base.text + (event.text ?? '') }
        if (event.type === 'status') return { ...base, status: event.text ?? event.message ?? base.status }
        return base
      })
    })
  }, [client, chat.id, session.id, onError, refresh])

  // While a turn runs, the local audit trail shows tool calls even from Agents that do not stream them.
  useEffect(() => {
    if (!busyReply || turnStartedAt === null) return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      const rows = await client.audit(8)
      if (!live) return
      const since = turnStartedAt - 1000
      const steps = rows
        .filter((row) => Date.parse(row.timestamp) >= since)
        .reverse()
        .map((row): ProgressStep => ({
          id: `audit-${row.id}`,
          title: row.summary || capabilityLabel(row.actionId),
          status: row.ok ? 'done' : 'error',
          detail: `${row.actionId} · ${row.durationMs} ms`,
          ...(row.error ? { error: row.error } : {}),
        }))
      setAuditSteps((prev) => (JSON.stringify(prev) === JSON.stringify(steps) ? prev : steps))
      timer = setTimeout(() => void poll(), AUDIT_POLL_MS)
    }
    void poll()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [client, busyReply, turnStartedAt])

  useEffect(() => {
    const el = logRef.current
    if (!el || !stickBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, stream])

  const steps = useMemo(() => mergeSteps(pageSteps, streamSteps.length ? streamSteps : auditSteps), [pageSteps, streamSteps, auditSteps])
  const toolRunning = steps.some((step) => step.status === 'running')
  const activity: CollabActivity = toolRunning ? 'tool' : busyReply ? 'replying' : 'idle'
  const model = modelState.model ?? session.model
  useEffect(() => {
    onStatus({ activity, model, cwd: session.cwd })
  }, [activity, model, session.cwd, onStatus])
  useEffect(() => () => onStatus({ activity: 'idle' }), [onStatus])

  async function run(kind: 'send' | 'stop'): Promise<void> {
    const text = draft.trim()
    if (kind === 'send' && (pending.current || !text)) return
    if (kind === 'stop' && operation === 'stop') return
    if (kind === 'send') pending.current = true
    setOperation(kind)
    try {
      if (kind === 'send') {
        stickBottom.current = true
        const images = attachments.items.map(({ name, mime, dataUrl }) => ({ name, mime, dataUrl }))
        setPageSteps([])
        setStreamSteps([])
        setAuditSteps([])
        setTurnStartedAt(Date.now())
        await chat.send({
          session,
          text,
          studioContext: `${formatBoardContext(board, filter)}\n${toolProfileLine(profile)}`,
          profile,
          attachments: images,
        })
        if (active.current) {
          setDraft((value) => (value.trim() === text ? '' : value))
          attachments.clear()
          setWaitingAfter(lastSeq.current)
        }
      } else {
        await client.stop(chat.id, session.id)
        if (active.current) {
          setStream(null)
          setWaitingAfter(null)
        }
      }
      if (active.current) refresh()
    } catch (reason) {
      if (active.current) onError(reason)
    } finally {
      if (kind === 'send') pending.current = false
      if (active.current) setOperation((current) => (current === kind ? null : current))
    }
  }

  const chips = contextChips(board)
  const shownMessages = useMemo(
    () =>
      messages
        .map((message) => ({ ...message, text: sanitizeMessageText(message.text) }))
        .filter((message) => message.text || message.images?.length),
    [messages],
  )
  const streamText = stream ? sanitizeMessageText(stream.text) : ''
  const streamCaughtUp = stream ? caughtUp(stream.baseline) : false
  const showThinking = busyReply && !streamText && !steps.length

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {statsOpen ? (
        <div className="max-h-[45%] shrink-0 overflow-y-auto">
          <SessionStatsPanel
            client={client}
            backendId={chat.id}
            backendLabel={chat.label}
            sessionId={session.id}
            messages={messages}
            model={model}
            mcpToolCount={mcpToolCount}
          />
        </div>
      ) : null}
      <div
        ref={logRef}
        onScroll={(event) => {
          const el = event.currentTarget
          stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
        className="min-h-24 flex-1 space-y-3 overflow-y-auto rounded-lg bg-well p-3"
        role="log"
        aria-label={`${chat.name} 消息`}
        aria-live="polite"
      >
        {!shownMessages.length ? <EmptyState size="section" title="还没有消息" /> : null}
        {shownMessages.map((message) => (
          <div key={message.seq} className={message.role === 'user' ? 'rounded-lg bg-raised p-3' : 'rounded-lg bg-panel p-3'}>
            <FieldLabel>{message.role === 'user' ? '你' : chat.name}</FieldLabel>
            {message.images?.map((src, index) => (
              <img
                key={index}
                src={src}
                loading="lazy"
                alt={`对话图片 ${index + 1}`}
                className="mt-1 max-h-32 max-w-40 rounded-md object-contain"
              />
            ))}
            {message.role === 'assistant' ? (
              <div className="selectable mt-1 break-words text-ui text-ink">
                <MarkdownBody {...replyImages}>{message.text}</MarkdownBody>
              </div>
            ) : (
              <div className="selectable mt-1 whitespace-pre-wrap break-words text-ui text-ink">{message.text}</div>
            )}
          </div>
        ))}
        {streamText && !streamCaughtUp ? (
          <div className="flex flex-col gap-1 rounded-lg bg-panel p-3" data-stream-reply>
            <FieldLabel>{chat.name}</FieldLabel>
            <div className="selectable break-words text-ui text-ink">
              <MarkdownBody {...replyImages}>{streamText}</MarkdownBody>
            </div>
          </div>
        ) : null}
        {showThinking ? (
          <div className="flex items-center gap-1.5 rounded-lg bg-panel px-3 py-2 text-caption text-ink-2">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" strokeWidth={1.8} />
            <span>{stream?.status || `${chat.name} 正在思考与执行中…`}</span>
          </div>
        ) : null}
      </div>
      {dock}
      <StepProgressDock steps={steps} running={busyReply} startedAt={turnStartedAt} status={stream?.status} />
      <div
        className={cn('flex shrink-0 flex-col gap-1.5 rounded-lg transition-colors', dragging && 'bg-accent-soft')}
        onDragOver={(event) => {
          if (!Array.from(event.dataTransfer.types).includes('Files')) return
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          setDragging(false)
          const files = imageFilesOf(event.dataTransfer)
          if (!files.length) return
          event.preventDefault()
          void attachments.add(files)
        }}
      >
        <ContextChips
          chips={chips}
          filter={filter}
          onToggle={(part: ContextPart) => setFilter((current) => ({ ...current, [part]: current[part] === false }))}
        />
        <AttachmentTray state={attachments} disabled={operation !== null} />
        <Textarea
          aria-label={`发给 ${chat.name} 的消息`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={6000}
          placeholder="输入消息，Ctrl+Enter 发送；可粘贴或拖入图片…"
          rows={3}
          onPaste={(event) => {
            const files = imageFilesOf(event.clipboardData)
            if (!files.length) return
            if (!event.clipboardData.getData('text/plain')) event.preventDefault()
            void attachments.add(files)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              event.stopPropagation()
              if (!event.nativeEvent.isComposing && !event.repeat) void run('send')
            }
          }}
        />
      </div>
      <div className="flex min-w-0 items-center gap-1" data-composer-actions>
        <div className="min-w-0 flex-1">
          <ModelPicker
            client={client}
            backendId={chat.id}
            sessionId={session.id}
            fallbackModel={session.model}
            onModelChange={setModelState}
          />
        </div>
        <Button
          tone="ghost"
          size="xs"
          className="px-1.5"
          aria-label="停止当前回复"
          title="停止当前回复"
          disabled={operation === 'stop'}
          onClick={() => void run('stop')}
        >
          <Square className="size-3" aria-hidden="true" strokeWidth={1.8} />
          停止
        </Button>
        <Button tone="primary" size="sm" disabled={!draft.trim() || operation !== null} onClick={() => void run('send')}>
          {operation === 'send' ? '发送中…' : `发给 ${chat.name}`}
        </Button>
      </div>
    </div>
  )
}
