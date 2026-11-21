import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, Loader2, Plug, Square } from 'lucide-react'
import { Notice } from '../../../components/common/Notice'
import { Button, cn, Field, FieldLabel, Input, LoadingRow, MarkdownBody, Textarea } from '../../../components/ui'
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

const BACKEND_KEY = 'mossstudio.collab.backend'
const POLL_MS = 2000
const SESSIONS_POLL_MS = 10_000
const NO_PROJECTS: readonly CanvasProjectOption[] = []

function readBackend(): string {
  try {
    return localStorage.getItem(BACKEND_KEY) || FALLBACK_BACKENDS[0]!.id
  } catch {
    return FALLBACK_BACKENDS[0]!.id
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
  return items.map((m) => `${m.seq}:${m.role}:${m.text.length}:${m.text.slice(-24)}`).join('\n')
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

  const backend = backends.find((item) => item.id === backendId) ?? backends[0] ?? FALLBACK_BACKENDS[0]!

  const fail = useCallback(
    (reason: unknown) => setError(reason instanceof Error && reason.message ? reason.message : '无法连接 Agent，请确认它仍在运行后重试。'),
    [],
  )
  const clearError = useCallback(() => setError(''), [])

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
            title="一键接入 Codex CLI / Claude Code，复制 Skill 与 MCP 配置"
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
      {error ? <Notice tone="warn">{error}</Notice> : null}
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
  const custom = isCustomBackend(backend)

  async function connect(): Promise<void> {
    if (busy) return
    setBusy(true)
    onClearError()
    try {
      const customArgs = args.trim() ? args.trim().split(/\s+/) : undefined
      const info = await client.connect({
        backendId: backend.id,
        ...(custom && command.trim() ? { customCommand: command.trim() } : {}),
        ...(custom && customArgs ? { customArgs } : {}),
      })
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
    const ready = backend.available || custom
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <div className="flex justify-end">{toolbar}</div>
        <div className="flex flex-col gap-2.5 rounded-lg bg-well p-3" data-hub-connect={backend.id}>
          <div className="flex flex-col gap-1">
            <span className="text-ui font-medium text-ink">{backend.label}</span>
            <span className="text-caption text-ink-2 [overflow-wrap:anywhere]">
              {backend.detail ??
                (ready
                  ? '连接后即可在这里与它对话，它通过本机 MCP 工具操作画板。'
                  : '没有在这台电脑上找到它，请先安装后点左上角重新检测。')}
            </span>
          </div>
          {custom ? (
            <div className="flex flex-col gap-2">
              <Field label="启动命令" hint="支持 ACP 协议的 Agent 可执行文件，例如 npx 或完整路径。">
                <Input
                  value={command}
                  maxLength={1024}
                  spellCheck={false}
                  placeholder="例如：npx"
                  onChange={(event) => setCommand(event.target.value)}
                />
              </Field>
              <Field label="参数" hint="用空格分隔。">
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
  return <ProjectChat key={projectKey} {...shared} chat={chat} />
}

function ProjectChat({
  chat,

  ...shared
}: ChatShared & { chat: ChatBackend }): React.JSX.Element {
  const { client, board, onError, onClearError, onStatus, dock, toolbar, projects, onCreateProject } = shared
  const [sessions, setSessions] = useState<AgentSession[] | null>(null)
  const [binding, setBinding] = useState<ProjectSessionBinding>(() => readSessionBinding(chat.id, board.projectId))
  const [creating, setCreating] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  const listSessions = useCallback(() => client.listSessions(chat.id), [client, chat.id])
  const applySessions = useCallback((next: AgentSession[]) => {
    setSessions((prev) => (prev && sessionsSignature(prev) === sessionsSignature(next) ? prev : next))
  }, [])
  const refresh = usePoll(listSessions, applySessions, onError, !pickerOpen, SESSIONS_POLL_MS)
  // Only this project's conversations are candidates; the rest are imported from the picker.
  const pinned = useMemo(() => projectSessions(sessions ?? [], binding.pinnedIds), [sessions, binding.pinnedIds])
  const selectedId = chooseSession(pinned, binding.currentId)
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
    if (selectedId && selectedId !== binding.currentId) bind(selectedId)
  }, [selectedId, binding.currentId, bind])

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
      <div className="flex min-w-0 items-center gap-1" data-session-row>
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
        workspaces={workspaces}
        defaultCwd={session?.cwd}
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
            <Notice>这个项目还没有对话。点上方会话栏，从「按工作区 / 项目导入」选一段已有对话，或点「+」新建。</Notice>
          ) : (
            <Notice>还没有可用的对话。点上方会话栏右侧的「+」开始一段新对话。</Notice>
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
    () => messages.map((message) => ({ ...message, text: sanitizeMessageText(message.text) })).filter((message) => message.text),
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
        {!shownMessages.length ? <p className="text-ui text-ink-2">这里会同步所选会话。发送时会附上下方勾选的画板信息。</p> : null}
        {shownMessages.map((message) => (
          <div key={message.seq} className={message.role === 'user' ? 'rounded-lg bg-raised p-3' : 'rounded-lg bg-panel p-3'}>
            <FieldLabel>{message.role === 'user' ? '你' : chat.name}</FieldLabel>
            {message.role === 'assistant' ? (
              <div className="selectable mt-1 break-words text-ui text-ink">
                <MarkdownBody>{message.text}</MarkdownBody>
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
              <MarkdownBody>{streamText}</MarkdownBody>
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
