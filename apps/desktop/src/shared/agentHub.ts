import type { ToolProfileId } from './capabilities'

/** How long a request waits for the person before it counts as rejected. MCP clients get a tool timeout longer than this. */
export const APPROVAL_WAIT_MS = 120_000
interface AgentSessionBase {
  id: string
  title: string
  running?: boolean
  model?: string
  provider?: string
  reasoningEffort?: string
  cwd?: string
  agentPreset?: string
  updatedAt?: number
}
export interface AgentMessagePage {
  messages: Array<{ seq: number; role: 'user' | 'assistant'; text: string; images?: string[] }>
  steps?: Array<{ id: string; title: string; status: 'running' | 'done' | 'error'; detail?: string }>
  hasMore: boolean
  asOfSeq: number
}

export interface AgentBackendInfo {
  id: string
  label: string
  /** `acp` is a command that speaks ACP; `dsh-desktop` is another DeepSeek Harness on this computer. */
  kind: 'acp' | 'dsh-desktop'
  /** First available driver, unless the person explicitly picked another. */
  preferred?: boolean
  available: boolean
  connected: boolean
  command?: string
  detail?: string
  /** Its conversations outlive a restart: it lists them (`session/list`) and loads them again (`session/load`). */
  resumable?: boolean
}
/** A DSH workspace, i.e. a folder whose conversations belong together. */
export interface AgentProject {
  id: string
  title: string
  cwd: string
  sessionIds: string[]
}
export interface AgentSession extends AgentSessionBase {
  projectId?: string
  provider?: string
}
export interface AgentModels {
  models: Array<{ id: string; label: string; provider?: string; reasoningEfforts?: string[] }>
  currentModel?: string
  currentProvider?: string
  currentReasoningEffort?: string
}
export interface AgentSetModelInput {
  backendId: string
  sessionId: string
  model: string
  provider?: string
  reasoningEffort?: string
}
export interface AgentSessionStats {
  messageCount: number
  userTurns: number
  assistantTurns: number
  estimatedChars: number
  tokenUsage?: { input?: number; output?: number; contextWindow?: number }
  activeMcpTools: number
  recentToolCalls: number
  model?: string
  provider?: string
  cwd?: string
  running: boolean
  updatedAt?: number
}
export interface AgentConnectInput {
  backendId: string
  customCommand?: string
  customArgs?: string[]
  pairingUrl?: string
}
export interface AgentCreateSessionInput {
  backendId: string
  title?: string
  /** A DSH workspace to put the conversation in (the driver makes one when only `cwd` is given). */
  workspaceId?: string
  cwd?: string
  /** Create `cwd` first: the person chose to start a new project folder. */
  createCwd?: boolean
  projectId?: string
  agentPreset?: string
  model?: string
  provider?: string
}
export interface AgentSendInput {
  backendId: string
  sessionId: string
  requestId?: string
  text: string
  studioContext?: string
  toolProfile?: ToolProfileId
  /** Pictures carried inline; main never reads a file the renderer names. */
  attachments?: Array<{ name: string; mime: string; dataUrl?: string }>
}
export interface AgentHubEvent {
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
export interface PendingCapabilityApproval {
  id: string
  actionId: string
  packId: string
  title: string
  summary: string
  argsPreview: string
  source: 'assistant' | 'ipc' | 'external-agent' | 'system'
  createdAt: string
}
export type CapabilityApprovalRequest = Omit<PendingCapabilityApproval, 'id' | 'createdAt'>
export interface AgentDriver {
  readonly id: string
  probe(): Promise<AgentBackendInfo>
  connect(input: AgentConnectInput): Promise<AgentBackendInfo>
  disconnect(): Promise<void>
  /** Workspaces this Agent groups conversations by; absent when it has none. */
  listProjects?(): Promise<AgentProject[]>
  listSessions(): Promise<AgentSession[]>
  createSession(input: AgentCreateSessionInput): Promise<{ sessionId: string }>
  readMessages(sessionId: string): Promise<AgentMessagePage>
  send(input: AgentSendInput): Promise<void>
  stop(sessionId: string): Promise<void>
  models(sessionId?: string): Promise<AgentModels>
  setModel(input: AgentSetModelInput): Promise<{ ok: true; model: string; provider?: string; reasoningEffort?: string }>
  telemetry?(sessionId: string): Promise<Partial<AgentSessionStats>>
}
