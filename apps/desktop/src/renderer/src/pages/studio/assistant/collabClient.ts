import { Events, Ipc } from '@shared/channels'
import type { GuideTopic, ToolProfileId } from '@shared/capabilities'
import { ApiError, call, onEvent } from '../../../lib/api'
import { setSessionsResumable } from './sessionBindings'

/**
 * Typed access to the Agent hub (`agent-hub:*`), the MCP server and the
 * capability approval queue. Answers are normalised here, so the panel works
 * with a hub that leaves optional fields out or a build that has no hub yet.
 */

export interface AgentBackendInfo {
  id: string
  label: string
  available: boolean
  connected: boolean
  command?: string
  detail?: string
  /** Its conversations can be listed and loaded again after a restart. */
  resumable?: boolean
}

export interface AgentSession {
  id: string
  title: string
  running?: boolean
  model?: string
  agentPreset?: string
  cwd?: string
  updatedAt?: number
}

export interface AgentMessage {
  seq: number
  role: 'user' | 'assistant'
  text: string
}

export interface AgentStep {
  id: string
  title: string
  status: 'running' | 'done' | 'error'
  detail?: string
  error?: string
}

export interface AgentMessagePage {
  messages: AgentMessage[]
  hasMore: boolean
  asOfSeq: number
  /** Tool steps of the turn in progress, when the Agent reports them with the page. */
  steps?: AgentStep[]
}

export interface AgentHubStreamEvent {
  backendId: string
  sessionId: string
  type: 'status' | 'delta' | 'tool-start' | 'tool-end' | 'done' | 'error'
  text?: string
  callId?: string
  toolName?: string
  ok?: boolean
  detail?: string
  message?: string
}

export type ApprovalSource = 'assistant' | 'ipc' | 'external-agent' | 'system'

export interface PendingApproval {
  id: string
  actionId: string
  packId: string
  title: string
  summary: string
  argsPreview: string
  source: ApprovalSource
  createdAt: string
}

export interface CollabAttachment {
  name: string
  mime: string
  dataUrl?: string
}

export interface CollabSendInput {
  backendId: string
  sessionId: string
  requestId?: string
  text: string
  studioContext?: string
  toolProfile?: ToolProfileId
  attachments?: CollabAttachment[]
}

export interface CollabConnectInput {
  backendId: string
  customCommand?: string
  customArgs?: string[]
}

export interface AgentModelOption {
  id: string
  label: string
  provider?: string
}

export interface AgentModelCatalog {
  models: AgentModelOption[]
  currentModel?: string
  currentProvider?: string
  currentReasoningEffort?: string
  reasoningEfforts: string[]
}

export interface CollabSetModelInput {
  backendId: string
  sessionId: string
  model: string
  provider?: string
  reasoningEffort?: string
}

export interface AgentTokenUsage {
  input?: number
  output?: number
  total?: number
  /** The model's context window, when the Agent knows it. */
  limit?: number
}

export interface CollabSessionStats {
  model?: string
  provider?: string
  cwd?: string
  messageCount?: number
  turnCount?: number
  tokenUsage?: AgentTokenUsage
  running?: boolean
}

export interface CollabCreateSessionInput {
  title?: string
  cwd?: string
  /** Create `cwd` before the Agent starts: a new project folder. */
  createCwd?: boolean
  projectId?: string
  agentPreset?: string
  model?: string
  provider?: string
}

export interface AuditRow {
  id: string
  timestamp: string
  actionId: string
  summary: string
  ok: boolean
  durationMs: number
  source: string
  error?: string
}

export interface McpSummary {
  running: boolean
  toolCount: number
  profile: string
}

export const CUSTOM_BACKEND = 'custom-acp'

/** Shown until the hub answers, and when this build has none. */
export const FALLBACK_BACKENDS: readonly AgentBackendInfo[] = [
  { id: 'codex-acp', label: 'Codex ACP', available: false, connected: false },
  { id: CUSTOM_BACKEND, label: '自定义 ACP', available: true, connected: false },
]

export const HUB_MISSING_DETAIL = '这个版本的 MossStudio 还不能连接它'

export function isCustomBackend(backend: Pick<AgentBackendInfo, 'id'>): boolean {
  return backend.id.includes('custom')
}

/** A channel the main process has no handler for (an older build, or a mock without it). */
export function isHubMissing(error: unknown): boolean {
  if (error instanceof ApiError) return error.code === 'E_MOCK_UNHANDLED' || error.code === 'E_NO_HANDLER'
  const message = error instanceof Error ? error.message : String(error)
  return /no handler registered|has no handler/i.test(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function listOf(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : []
}

export function normalizeBackend(value: unknown): AgentBackendInfo | null {
  if (!isRecord(value)) return null
  const id = text(value.id)
  if (!id) return null
  return {
    id,
    label: text(value.label) || id,
    available: value.available !== false,
    connected: value.connected === true,
    ...(text(value.command) ? { command: text(value.command) } : {}),
    ...(text(value.detail) ? { detail: text(value.detail) } : {}),
    ...(value.resumable === true ? { resumable: true } : {}),
  }
}

export function normalizeBackends(value: unknown): AgentBackendInfo[] {
  const seen = new Set<string>()
  const result: AgentBackendInfo[] = []
  for (const item of listOf(value, 'backends')) {
    const backend = normalizeBackend(item)
    if (!backend || seen.has(backend.id)) continue
    seen.add(backend.id)
    result.push(backend)
  }
  return result.length ? result : FALLBACK_BACKENDS.map((backend) => ({ ...backend }))
}

export function normalizeSession(value: unknown): AgentSession | null {
  if (!isRecord(value)) return null
  const id = text(value.id) ?? text(value.sessionId)
  if (!id) return null
  return {
    id,
    title: text(value.title) || '未命名对话',
    ...(typeof value.running === 'boolean' ? { running: value.running } : {}),
    ...(text(value.model) ? { model: text(value.model) } : {}),
    ...(text(value.agentPreset) ? { agentPreset: text(value.agentPreset) } : {}),
    ...(text(value.cwd) ? { cwd: text(value.cwd) } : {}),
    ...(typeof value.updatedAt === 'number' ? { updatedAt: value.updatedAt } : {}),
  }
}

export function normalizeSessions(value: unknown): AgentSession[] {
  return listOf(value, 'sessions')
    .map(normalizeSession)
    .filter((item): item is AgentSession => item !== null)
}

/** The conversation to show: the remembered one when it still exists, else a running or the newest one. */
export function chooseSession(items: readonly AgentSession[], preferred: string): string {
  if (items.some((item) => item.id === preferred)) return preferred
  return [...items].sort((a, b) => Number(!!b.running) - Number(!!a.running) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]?.id ?? ''
}

export function normalizeSteps(list: readonly unknown[]): AgentStep[] {
  const steps: AgentStep[] = []
  list.forEach((item, index) => {
    if (!isRecord(item)) return
    const title = text(item.title) ?? text(item.label) ?? text(item.name) ?? text(item.toolName)
    if (!title) return
    const raw = text(item.status)
    const status: AgentStep['status'] =
      raw === 'error' || raw === 'failed' || item.ok === false
        ? 'error'
        : raw === 'running' || raw === 'in_progress' || raw === 'pending'
          ? 'running'
          : 'done'
    const detail = text(item.detail)
    const error = text(item.error)
    steps.push({
      id: text(item.id) ?? text(item.callId) ?? `step-${index}`,
      title,
      status,
      ...(detail ? { detail } : {}),
      ...(error ? { error } : {}),
    })
  })
  return steps
}

export function normalizeMessages(value: unknown): AgentMessagePage {
  const messages: AgentMessage[] = []
  for (const item of listOf(value, 'messages')) {
    if (!isRecord(item) || typeof item.seq !== 'number') continue
    const role = item.role === 'user' ? 'user' : item.role === 'assistant' ? 'assistant' : null
    if (role) messages.push({ seq: item.seq, role, text: text(item.text) ?? '' })
  }
  const asOfSeq = isRecord(value) && typeof value.asOfSeq === 'number' ? value.asOfSeq : (messages.at(-1)?.seq ?? 0)
  const steps = isRecord(value) && Array.isArray(value.steps) ? normalizeSteps(value.steps) : []
  return { messages, hasMore: isRecord(value) && value.hasMore === true, asOfSeq, ...(steps.length ? { steps } : {}) }
}

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const STUDIO_CONTEXT_TAIL = /\n\n\[Current Studio context\][\s\S]*$/

/** Strip what the hub wraps around a turn (reminders, the attached board context) before it reaches a bubble. */
export function sanitizeMessageText(value: string): string {
  return value.replace(SYSTEM_REMINDER, '').replace(STUDIO_CONTEXT_TAIL, '').trim()
}

export function normalizeModels(value: unknown): AgentModelCatalog {
  const record = isRecord(value) ? value : {}
  const models: AgentModelOption[] = []
  for (const item of listOf(value, 'models')) {
    if (typeof item === 'string' && item) models.push({ id: item, label: item })
    else if (isRecord(item)) {
      const id = text(item.id) ?? text(item.model) ?? text(item.name)
      if (!id) continue
      const provider = text(item.provider)
      models.push({ id, label: text(item.label) || text(item.name) || id, ...(provider ? { provider } : {}) })
    }
  }
  // Efforts may sit on the catalog or on the current model.
  const current = text(record.currentModel)
  const owner = listOf(value, 'models').find((item) => isRecord(item) && text(item.id) === current)
  const raw = Array.isArray(record.reasoningEfforts)
    ? record.reasoningEfforts
    : isRecord(owner) && Array.isArray(owner.reasoningEfforts)
      ? owner.reasoningEfforts
      : []
  return {
    models,
    ...(current ? { currentModel: current } : {}),
    ...(text(record.currentProvider) ? { currentProvider: text(record.currentProvider) } : {}),
    ...(text(record.currentReasoningEffort) ? { currentReasoningEffort: text(record.currentReasoningEffort) } : {}),
    reasoningEfforts: raw.filter((effort): effort is string => typeof effort === 'string' && !!effort),
  }
}

export function normalizeStats(value: unknown): CollabSessionStats {
  if (!isRecord(value)) return {}
  const usage = isRecord(value.tokenUsage) ? value.tokenUsage : null
  const tokenUsage: AgentTokenUsage | undefined = usage
    ? {
        input: count(usage.input ?? usage.inputTokens),
        output: count(usage.output ?? usage.outputTokens),
        total: count(usage.total ?? usage.totalTokens ?? usage.used),
        limit: count(usage.limit ?? usage.contextWindow),
      }
    : undefined
  const turns = count(value.turnCount) ?? count(value.userTurns)
  return {
    ...(text(value.model) ? { model: text(value.model) } : {}),
    ...(text(value.provider) ? { provider: text(value.provider) } : {}),
    ...(text(value.cwd) ? { cwd: text(value.cwd) } : {}),
    ...(count(value.messageCount) !== undefined ? { messageCount: count(value.messageCount) } : {}),
    ...(turns !== undefined ? { turnCount: turns } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(typeof value.running === 'boolean' ? { running: value.running } : {}),
  }
}

export function normalizeAudit(value: unknown): AuditRow[] {
  const rows: AuditRow[] = []
  for (const item of listOf(value, 'entries')) {
    if (!isRecord(item)) continue
    const id = text(item.id)
    if (!id) continue
    const error = text(item.error)
    rows.push({
      id,
      timestamp: text(item.timestamp) ?? '',
      actionId: text(item.actionId) ?? '',
      summary: text(item.summary) ?? '',
      ok: item.ok !== false,
      durationMs: count(item.durationMs) ?? 0,
      source: text(item.source) ?? '',
      ...(error ? { error } : {}),
    })
  }
  return rows
}

const SOURCES: readonly ApprovalSource[] = ['assistant', 'ipc', 'external-agent', 'system']

export function normalizeApprovals(value: unknown): PendingApproval[] {
  const result: PendingApproval[] = []
  for (const item of listOf(value, 'pending')) {
    if (!isRecord(item)) continue
    const id = text(item.id)
    if (!id) continue
    const actionId = text(item.actionId) ?? ''
    result.push({
      id,
      actionId,
      packId: text(item.packId) ?? '',
      title: text(item.title) || actionId || '外部工具操作',
      summary: text(item.summary) ?? '',
      argsPreview: text(item.argsPreview) ?? '',
      source: SOURCES.find((source) => source === item.source) ?? 'external-agent',
      createdAt: text(item.createdAt) ?? '',
    })
  }
  return result
}

/** The Agents MossStudio can write itself into, in the order the wizard shows them. */
export const MCP_CLIENT_IDS = ['codex', 'claude-code'] as const
export type McpClientId = (typeof MCP_CLIENT_IDS)[number]

const MCP_CLIENT_LABELS: Record<McpClientId, string> = { codex: 'Codex CLI', 'claude-code': 'Claude Code' }

export interface McpClientStatus {
  id: McpClientId
  label: string
  configPath: string
  detected: boolean
  installed: boolean
  installMode: 'auto' | 'copy-only'
  detail: string
  backupPath?: string
}

export interface McpConnection {
  url: string
  token: string
  toolCount: number
  discoveryPath: string
  stdioBridgePath: string
}

export function normalizeMcpClient(value: unknown): McpClientStatus | null {
  if (!isRecord(value)) return null
  const id = MCP_CLIENT_IDS.find((item) => item === value.id)
  if (!id) return null
  const backupPath = text(value.backupPath)
  return {
    id,
    label: text(value.label) || MCP_CLIENT_LABELS[id],
    configPath: text(value.configPath) ?? '',
    detected: value.detected === true,
    installed: value.installed === true,
    installMode: value.installMode === 'copy-only' ? 'copy-only' : 'auto',
    detail: text(value.detail) ?? '',
    ...(backupPath ? { backupPath } : {}),
  }
}

/** Always the known Agents in a fixed order; one the answer leaves out shows as not configured. */
export function normalizeMcpClients(value: unknown): McpClientStatus[] {
  const found = new Map<McpClientId, McpClientStatus>()
  for (const item of listOf(value, 'clients')) {
    const status = normalizeMcpClient(item)
    if (status && !found.has(status.id)) found.set(status.id, status)
  }
  return MCP_CLIENT_IDS.map(
    (id) =>
      found.get(id) ?? {
        id,
        label: MCP_CLIENT_LABELS[id],
        configPath: '',
        detected: false,
        installed: false,
        installMode: 'copy-only',
        detail: '',
      },
  )
}

export function normalizeMcpConnection(value: unknown): McpConnection | null {
  if (!isRecord(value) || value.running !== true) return null
  const url = text(value.url)
  const token = text(value.token)
  if (!url || !token) return null
  return {
    url,
    token,
    toolCount: count(value.toolCount) ?? 0,
    discoveryPath: text(value.discoveryPath) ?? '',
    stdioBridgePath: text(value.stdioBridgePath) ?? '',
  }
}

export type McpConfigKind = 'all' | 'http' | 'stdio'

/** The standard `mcpServers` JSON most Agents accept: Streamable HTTP, the stdio bridge, or both. */
export function mcpConfigJson(connection: McpConnection, kind: McpConfigKind = 'all'): string {
  const http = { mossstudio: { url: connection.url, headers: { Authorization: `Bearer ${connection.token}` } } }
  const stdio = {
    'mossstudio-stdio': {
      command: 'node',
      args: [connection.stdioBridgePath],
      env: { MOSSSTUDIO_MCP_DISCOVERY: connection.discoveryPath },
    },
  }
  const servers = kind === 'http' ? http : kind === 'stdio' ? stdio : { ...http, ...stdio }
  return JSON.stringify({ mcpServers: servers }, null, 2)
}

/** `capabilities:execute` answers `{ ok, content }` with the tool's JSON (or Markdown) in `content`. */
export function guideMarkdown(result: unknown): string | null {
  if (!isRecord(result) || result.ok === false) return null
  let body: unknown = result.content
  if (typeof body === 'string') {
    const raw = body
    try {
      body = JSON.parse(raw) as unknown
    } catch {
      return raw.trim() ? raw : null
    }
  }
  if (!isRecord(body)) return null
  const markdown = text(body.markdown) ?? text(body.text) ?? text(body.content)
  return markdown?.trim() ? markdown : null
}

export interface GuideReadInput {
  topic: GuideTopic
  profile?: ToolProfileId
  enabledPacks?: readonly string[]
}

export interface CollabClient {
  mcpClients(): Promise<McpClientStatus[] | null>
  installMcpClient(clientId: McpClientId): Promise<McpClientStatus>
  uninstallMcpClient(clientId: McpClientId): Promise<McpClientStatus>
  /** The live MCP connection, token included, for copying a config; null when the server is not running. */
  mcpConnection(): Promise<McpConnection | null>
  mcpSummary(): Promise<McpSummary | null>
  /** One official Skill as the MCP server serves it; null when it cannot answer. */
  readGuide(input: GuideReadInput): Promise<string | null>
  listBackends(): Promise<AgentBackendInfo[]>
  connect(input: CollabConnectInput): Promise<AgentBackendInfo | null>
  disconnect(backendId: string): Promise<void>
  listSessions(backendId: string): Promise<AgentSession[]>
  createSession(backendId: string, input?: CollabCreateSessionInput): Promise<string>
  /** Null when the Agent cannot list models. */
  listModels(backendId: string, sessionId?: string): Promise<AgentModelCatalog | null>
  /** False when this Agent cannot switch models. */
  setModel(input: CollabSetModelInput): Promise<boolean>
  sessionStats(backendId: string, sessionId: string): Promise<CollabSessionStats | null>
  audit(limit: number): Promise<AuditRow[]>
  pickFolder(title: string): Promise<string | null>
  readMessages(backendId: string, sessionId: string): Promise<AgentMessagePage>
  send(input: CollabSendInput): Promise<void>
  stop(backendId: string, sessionId: string): Promise<void>
  listApprovals(): Promise<PendingApproval[]>
  resolveApproval(id: string, decision: 'approve' | 'reject'): Promise<boolean>
  setToolProfile(profile: ToolProfileId, enabledPacks?: readonly string[]): Promise<void>
  onStream(listener: (event: AgentHubStreamEvent) => void): () => void
  onApprovals(listener: (pending: PendingApproval[]) => void): () => void
}

type Invoke = <T>(channel: string, payload?: unknown) => Promise<T>
type Subscribe = <T>(channel: string, callback: (data: T) => void) => () => void

const STREAM_TYPES = new Set(['status', 'delta', 'tool-start', 'tool-end', 'done', 'error'])

/** Which Agents keep their conversations across a restart decides where their project bindings are stored. */
function rememberResumable(backends: AgentBackendInfo[]): AgentBackendInfo[] {
  for (const backend of backends) setSessionsResumable(backend.id, backend.resumable === true)
  return backends
}

export function createCollabClient(invoke: Invoke = call, subscribe: Subscribe = onEvent): CollabClient {
  return {
    async mcpClients() {
      try {
        return normalizeMcpClients(await invoke<unknown>(Ipc.mcpClientsStatus))
      } catch {
        return null
      }
    },

    async installMcpClient(clientId) {
      const result = normalizeMcpClient(await invoke<unknown>(Ipc.mcpClientInstall, { clientId }))
      if (!result) throw new Error('没有收到安装结果，请刷新后查看状态')
      return result
    },

    async uninstallMcpClient(clientId) {
      const result = normalizeMcpClient(await invoke<unknown>(Ipc.mcpClientUninstall, { clientId }))
      if (!result) throw new Error('没有收到卸载结果，请刷新后查看状态')
      return result
    },

    async mcpConnection() {
      try {
        return normalizeMcpConnection(await invoke<unknown>(Ipc.mcpInfo, { includeToken: true }))
      } catch {
        return null
      }
    },

    async mcpSummary() {
      try {
        const info = await invoke<unknown>(Ipc.mcpInfo, {})
        if (!isRecord(info)) return null
        return { running: info.running === true, toolCount: count(info.toolCount) ?? 0, profile: text(info.profile) ?? '' }
      } catch {
        return null
      }
    },

    async readGuide({ topic, profile, enabledPacks }) {
      try {
        const result = await invoke<unknown>(Ipc.capabilitiesExecute, {
          name: 'system.guide.read',
          arguments: {
            topic,
            ...(profile ? { profile } : {}),
            ...(profile === 'custom' && enabledPacks ? { enabledPacks: [...enabledPacks] } : {}),
          },
        })
        return guideMarkdown(result)
      } catch {
        return null
      }
    },

    async listBackends() {
      try {
        return rememberResumable(normalizeBackends(await invoke<unknown>(Ipc.agentHubBackends)))
      } catch (error) {
        if (!isHubMissing(error)) throw error
        return FALLBACK_BACKENDS.map((backend) => (isCustomBackend(backend) ? { ...backend } : { ...backend, detail: HUB_MISSING_DETAIL }))
      }
    },

    async connect(input) {
      const backend = normalizeBackend(await invoke<unknown>(Ipc.agentHubConnect, input))
      if (backend) rememberResumable([backend])
      return backend
    },

    async disconnect(backendId) {
      await invoke(Ipc.agentHubDisconnect, { backendId })
    },

    async listSessions(backendId) {
      return normalizeSessions(await invoke<unknown>(Ipc.agentHubSessions, { backendId }))
    },

    async createSession(backendId, input = {}) {
      const payload = Object.fromEntries(Object.entries({ backendId, ...input }).filter(([, value]) => value !== undefined && value !== ''))
      const result = await invoke<unknown>(Ipc.agentHubCreateSession, payload)
      const id = isRecord(result) ? (text(result.sessionId) ?? text(result.id)) : undefined
      if (!id) throw new Error('Agent 没有返回新对话')
      return id
    },

    async listModels(backendId, sessionId) {
      try {
        return normalizeModels(await invoke<unknown>(Ipc.agentHubModels, { backendId, ...(sessionId ? { sessionId } : {}) }))
      } catch {
        return null
      }
    },

    async setModel(input) {
      try {
        await invoke(Ipc.agentHubSetModel, input)
        return true
      } catch (error) {
        if (isHubMissing(error)) return false
        throw error
      }
    },

    async sessionStats(backendId, sessionId) {
      try {
        return normalizeStats(await invoke<unknown>(Ipc.agentHubSessionStats, { backendId, sessionId }))
      } catch {
        return null
      }
    },

    async audit(limit) {
      try {
        return normalizeAudit(await invoke<unknown>(Ipc.capabilitiesAudit, { limit }))
      } catch {
        return []
      }
    },

    async pickFolder(title) {
      const picked = await invoke<unknown>(Ipc.pickDialog, { kind: 'folder', title })
      return typeof picked === 'string' && picked ? picked : null
    },

    async readMessages(backendId, sessionId) {
      return normalizeMessages(await invoke<unknown>(Ipc.agentHubMessages, { backendId, sessionId }))
    },

    async send(input) {
      await invoke(Ipc.agentHubSend, input)
    },

    async stop(backendId, sessionId) {
      await invoke(Ipc.agentHubStop, { backendId, sessionId })
    },

    async listApprovals() {
      try {
        return normalizeApprovals(await invoke<unknown>(Ipc.agentHubApprovals))
      } catch {
        // No approval queue in this build: nothing is waiting.
        return []
      }
    },

    async resolveApproval(id, decision) {
      const result = await invoke<unknown>(Ipc.agentHubResolveApproval, { id, decision })
      return !(result === false || (isRecord(result) && result.resolved === false))
    },

    async setToolProfile(profile, enabledPacks) {
      await invoke(Ipc.mcpSetProfile, profile === 'custom' ? { profile, enabledPacks: [...(enabledPacks ?? [])] } : { profile })
    },

    onStream(listener) {
      return subscribe<unknown>(Events.agentHubEvent, (data) => {
        if (!isRecord(data) || typeof data.backendId !== 'string' || typeof data.sessionId !== 'string') return
        if (typeof data.type !== 'string' || !STREAM_TYPES.has(data.type)) return
        listener(data as unknown as AgentHubStreamEvent)
      })
    },

    onApprovals(listener) {
      return subscribe<unknown>(Events.capabilityApproval, (data) => listener(normalizeApprovals(data)))
    },
  }
}
