import type { AgentCard } from './agent/cards'

export type AiProviderKind = 'openai' | 'anthropic' | 'gemini' | 'ollama'

/** How much the Agent does on its own. Persisted per conversation. */
export type AgentMode = 'auto' | 'advanced'

export interface AiProviderInfo {
  id: string
  name: string
  kind: AiProviderKind
  baseUrl: string
  model: string
  temperature: number
  hasKey: boolean
  /** The provider answered that this model takes no pictures; cleared when its model or address changes. */
  noImageInput?: boolean
}

export interface AiProviderInput {
  id?: string
  name: string
  kind: AiProviderKind
  baseUrl: string
  model: string
  apiKey?: string
  temperature?: number
}

/** A tool invocation requested by the model, in the shape MCP servers use. */
export interface AiToolCall {
  id: string
  name: string
  /** Raw JSON string exactly as the model produced it. */
  arguments: string
}

/** Result returned to the model for one tool call. */
export interface AiToolResult {
  ok: boolean
  content: string
}

export type AiRole = 'system' | 'user' | 'assistant' | 'tool'

export interface AiMessage {
  id: string
  role: AiRole
  content: string
  createdAt: string
  /** Assistant turns that asked for tools. */
  toolCalls?: AiToolCall[]
  /** Tool result turns. */
  toolCallId?: string
  name?: string
  /** Tool result failed. */
  error?: boolean
  /** The Agent asked something in the chat; the answer is filled in later. */
  card?: AgentCard
}

export interface AiConversationInfo {
  id: string
  title: string
  providerId: string
  messages: AiMessage[]
  /** auto: the Agent acts; advanced: it proposes and the user confirms. */
  mode?: AgentMode
  createdAt: string
  updatedAt: string
}

export interface AiChatInput {
  providerId: string
  conversationId?: string
  /** Only the new turn; the conversation already holds the earlier ones. */
  message?: string
  /** Re-run the last user turn instead of appending a new one. */
  regenerate?: boolean
  /** Extra context appended to the system prompt (current Canvas, params…). */
  context?: string
  /** How much the Agent may do on its own; defaults to the conversation's mode. */
  mode?: AgentMode
}

export interface AiChatResult {
  reply: string
  conversation: AiConversationInfo
}

/** MCP-style tool description: name/description/inputSchema. */
export interface AiToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Events streamed to the renderer while a chat turn is running. */
export type AiStreamEvent =
  | { type: 'start'; conversationId: string; messageId: string }
  | { type: 'delta'; conversationId: string; messageId: string; text: string }
  | { type: 'tool'; conversationId: string; call: AiToolCall }
  | { type: 'tool-result'; conversationId: string; callId: string; result: AiToolResult }
  | { type: 'done'; conversationId: string; conversation: AiConversationInfo }
  | { type: 'error'; conversationId: string; message: string }

/** Sent from main to the renderer when a tool must run against Studio state. */
export interface AiToolCallRequest {
  callId: string
  name: string
  arguments: string
  /** Advanced mode turns a write into a plan step instead of changing anything. */
  mode?: AgentMode
  /** The turn that asked (its reply's message id): the Studio makes one undo step of a turn's changes. */
  turnId?: string
}

export interface AiProviderPreset {
  kind: AiProviderKind
  name: string
  baseUrl: string
  model: string
  /** The preset's model reads text only, so 看图 does not offer it. */
  textOnly?: true
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  { kind: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  { kind: 'openai', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', textOnly: true },
  { kind: 'openai', name: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', textOnly: true },
  { kind: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  { kind: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
  { kind: 'ollama', name: 'Ollama (local)', baseUrl: 'http://127.0.0.1:11434', model: 'llama3.1' },
]

/** The kinds a connection for 看图 can be: KohakuGBC talks to the OpenAI-compatible and Anthropic APIs only. */
export const PICTURE_KINDS: readonly AiProviderKind[] = ['openai', 'anthropic']

/**
 * Whether 看图 (解析, 拆成区域) can use a connection: one of `PICTURE_KINDS`
 * with a key, unless its provider answered that the model takes no pictures.
 */
export function seesPictures(provider: Pick<AiProviderInfo, 'kind' | 'hasKey' | 'noImageInput'>): boolean {
  return provider.hasKey && PICTURE_KINDS.includes(provider.kind) && !provider.noImageInput
}

/** The presets the connect dialog offers: for 看图, only those whose model can see pictures through KohakuGBC. */
export function presetsFor(vision: boolean): AiProviderPreset[] {
  return vision ? AI_PROVIDER_PRESETS.filter((preset) => PICTURE_KINDS.includes(preset.kind) && !preset.textOnly) : AI_PROVIDER_PRESETS
}

/** The model for 助手和漫画 (the assistant, 漫画 storyboard, training captions): the chosen one, else the first connected. */
export function languageProvider<T extends { id: string }>(providers: readonly T[], chosen: string | null | undefined): T | undefined {
  return providers.find((provider) => provider.id === chosen) ?? providers[0]
}

/** The model for 看图: the chosen one while it can still see pictures, else the first that can. */
export function visionProvider<T extends Pick<AiProviderInfo, 'id' | 'kind' | 'hasKey' | 'noImageInput'>>(
  providers: readonly T[],
  chosen: string | null | undefined,
): T | undefined {
  const usable = providers.filter(seesPictures)
  return usable.find((provider) => provider.id === chosen) ?? usable[0]
}
