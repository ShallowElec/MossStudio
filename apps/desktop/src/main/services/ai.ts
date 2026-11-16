import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentMode,
  AiChatInput,
  AiChatResult,
  AiConversationInfo,
  AiMessage,
  AiProviderInfo,
  AiProviderInput,
  AiProviderKind,
  AiStreamEvent,
  AiToolCall,
  AiToolDefinition,
  AiToolResult,
} from '@shared/ai'
import { agentCardSchema, makeCard, planStepSchema, type AgentCard, type AgentCardAnswer, type PlanStep } from '@shared/agent/cards'
import { MODE_RULES, TOOL_RULES } from '@shared/agent/registry'
import { paths } from '../lib/paths'
import { codedError } from '../lib/codedError'

interface StoredProvider extends AiProviderInfo {
  apiKey: string
}

interface Store {
  providers: StoredProvider[]
  conversations: AiConversationInfo[]
}

/** Message shape used inside this module, mapped per provider below. */
interface Turn {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: AiToolCall[]
  toolCallId?: string
  name?: string
}

function file(): string {
  return join(paths.root(), 'ai', 'agent.json')
}

function load(): Store {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Store>
    return {
      providers: Array.isArray(raw.providers) ? raw.providers : [],
      conversations: Array.isArray(raw.conversations) ? raw.conversations : [],
    }
  } catch {
    return { providers: [], conversations: [] }
  }
}

function save(store: Store): void {
  mkdirSync(join(paths.root(), 'ai'), { recursive: true })
  writeFileSync(file(), JSON.stringify(store, null, 2), 'utf8')
}

export function getProviderSecret(id: string): { kind: string; baseUrl: string; model: string; apiKey: string } | null {
  const provider = load().providers.find((item) => item.id === id)
  return provider ? { kind: provider.kind, baseUrl: provider.baseUrl, model: provider.model, apiKey: provider.apiKey } : null
}

function publicProvider(provider: StoredProvider): AiProviderInfo {
  const { apiKey: _apiKey, ...rest } = provider
  return { ...rest, hasKey: Boolean(provider.apiKey) }
}

export function listProviders(): AiProviderInfo[] {
  return load().providers.map(publicProvider)
}

export function saveProvider(input: AiProviderInput): AiProviderInfo {
  const store = load()
  const id = input.id || `provider-${randomUUID().slice(0, 8)}`
  const existing = store.providers.find((item) => item.id === id)
  const provider: StoredProvider = {
    id,
    name: input.name.trim() || 'Custom',
    kind: input.kind,
    baseUrl: input.baseUrl.replace(/\/$/, ''),
    model: input.model.trim(),
    temperature: input.temperature ?? 0.7,
    hasKey: Boolean(input.apiKey || existing?.apiKey),
    apiKey: input.apiKey?.trim() || existing?.apiKey || '',
  }
  store.providers = [provider, ...store.providers.filter((item) => item.id !== id)]
  save(store)
  return publicProvider(provider)
}

export function removeProvider(id: string): void {
  const store = load()
  store.providers = store.providers.filter((item) => item.id !== id)
  save(store)
}

export function listConversations(): AiConversationInfo[] {
  return load().conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function removeConversation(id: string): void {
  const store = load()
  store.conversations = store.conversations.filter((item) => item.id !== id)
  save(store)
}

export function renameConversation(id: string, title: string): AiConversationInfo | null {
  const store = load()
  const conversation = store.conversations.find((item) => item.id === id)
  if (!conversation) return null
  conversation.title = title.trim().slice(0, 120) || conversation.title
  conversation.updatedAt = new Date().toISOString()
  save(store)
  return conversation
}

/** Remember what the user chose on a card the Agent asked. */
export function answerAgentCard(conversationId: string, messageId: string, answer: AgentCardAnswer): AiConversationInfo {
  const store = load()
  const conversation = store.conversations.find((item) => item.id === conversationId)
  if (!conversation) throw new Error('这段对话已经不在了')
  const message = conversation.messages.find((item) => item.id === messageId)
  if (!message?.card) throw new Error('这张卡已经不在了')
  message.card.answer = answer
  conversation.updatedAt = new Date().toISOString()
  save(store)
  return conversation
}

/** The card a tool result asks the chat to show, when it carries a well formed one. */
function cardInResult(result: AiToolResult): AgentCard | null {
  if (!result.ok) return null
  try {
    const body = JSON.parse(result.content) as { card?: unknown }
    const parsed = agentCardSchema.safeParse(body.card)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** A write the advanced mode held back; it becomes one step of the plan card. */
function stepInResult(result: AiToolResult): PlanStep | null {
  if (!result.ok) return null
  try {
    const body = JSON.parse(result.content) as { proposed?: unknown }
    const parsed = planStepSchema.safeParse(body.proposed)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** One card for every write the turn held back, with the model's own words as the reason. */
function planCardFor(text: string, steps: PlanStep[]): AgentCard {
  const why = text.trim().slice(0, 300)
  return makeCard({
    kind: 'plan',
    title: steps.length === 1 ? steps[0]!.label : `将改动 ${steps.length} 处`,
    why: why || undefined,
    steps,
  })
}

const SYSTEM_PROMPT = `You are the agent inside MossStudio, a desktop workbench for the MOSS-Image model.

MOSS-Image renders text extremely well and is controlled with a prompt plus an optional layout:
- A Canvas has a size, sampler values (steps, cfg, seed) and a list of regions.
- Each region has a kind (object / character / text), a bounding box and a caption; text regions carry a second string, text.
- caption is English: a short description of what belongs in the region. On a text region it describes the lettering itself — style, weight, colour and placement — never the words.
- text is the exact characters to render, in the user's language, exactly as they should appear: no surrounding quotes and no "reading" prefix.
- Regions are what give layout control.

Work in the user's language, but prompts and captions stay in English.
Prefer doing over describing: when the user asks for a change, call the studio_* tools so the workbench actually changes, then summarise what you changed in one or two sentences.

${TOOL_RULES}`

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function toTurns(messages: AiMessage[]): Turn[] {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : message.role === 'tool' ? 'tool' : 'user',
      content: message.content,
      toolCalls: message.toolCalls,
      toolCallId: message.toolCallId,
      name: message.name,
    }))
}

// ---------------------------------------------------------------- OpenAI-compatible

function openAIMessages(system: string, turns: Turn[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }]
  for (const turn of turns) {
    if (turn.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: turn.toolCallId, content: turn.content })
    } else if (turn.role === 'assistant' && turn.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: turn.content || null,
        tool_calls: turn.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments || '{}' },
        })),
      })
    } else {
      out.push({ role: turn.role, content: turn.content })
    }
  }
  return out
}

async function openAIChat(
  provider: StoredProvider,
  system: string,
  turns: Turn[],
  tools: AiToolDefinition[],
  onDelta: (text: string) => void,
): Promise<{ text: string; toolCalls: AiToolCall[] }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: provider.temperature,
        stream: true,
        messages: openAIMessages(system, turns),
        ...(tools.length
          ? {
              tools: tools.map((tool) => ({
                type: 'function',
                function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
              })),
            }
          : {}),
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
      throw new Error(body?.error?.message ?? `HTTP ${response.status}`)
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('event-stream') || !response.body) {
      const body = (await response.json()) as {
        choices?: Array<{
          message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }
        }>
      }
      const message = body.choices?.[0]?.message
      const text = message?.content?.trim() ?? ''
      if (text) onDelta(text)
      const toolCalls = (message?.tool_calls ?? []).map((call, index) => ({
        id: call.id ?? `call-${index}`,
        name: call.function?.name ?? 'unknown',
        arguments: call.function?.arguments ?? '{}',
      }))
      return { text, toolCalls }
    }

    let text = ''
    const calls: Array<{ id: string; name: string; arguments: string }> = []
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string
              tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
            }
          }>
        }
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }
        const delta = chunk.choices?.[0]?.delta
        if (!delta) continue
        if (delta.content) {
          text += delta.content
          onDelta(delta.content)
        }
        for (const [fallbackIndex, raw] of (delta.tool_calls ?? []).entries()) {
          const index = raw.index ?? fallbackIndex
          const slot = calls[index] ?? (calls[index] = { id: '', name: '', arguments: '' })
          if (raw.id) slot.id = raw.id
          if (raw.function?.name) slot.name += raw.function.name
          if (raw.function?.arguments) slot.arguments += raw.function.arguments
        }
      }
    }
    return {
      text: text.trim(),
      toolCalls: calls
        .filter((call) => call.name)
        .map((call, index) => ({ id: call.id || `call-${index}`, name: call.name, arguments: call.arguments || '{}' })),
    }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- Anthropic

function anthropicMessages(turns: Turn[]): unknown[] {
  const out: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = []
  const push = (role: 'user' | 'assistant', blocks: unknown[]): void => {
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  for (const turn of turns) {
    if (turn.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: turn.toolCallId, content: turn.content }])
    } else if (turn.role === 'assistant') {
      const blocks: unknown[] = []
      if (turn.content) blocks.push({ type: 'text', text: turn.content })
      for (const call of turn.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: parseArgs(call.arguments) })
      }
      push('assistant', blocks.length ? blocks : [{ type: 'text', text: '' }])
    } else {
      push('user', [{ type: 'text', text: turn.content }])
    }
  }
  return out
}

async function anthropicChat(
  provider: StoredProvider,
  system: string,
  turns: Turn[],
  tools: AiToolDefinition[],
  onDelta: (text: string) => void,
): Promise<{ text: string; toolCalls: AiToolCall[] }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  try {
    const response = await fetch(`${provider.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 4096,
        temperature: provider.temperature,
        system,
        messages: anthropicMessages(turns),
        ...(tools.length
          ? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) }
          : {}),
      }),
      signal: controller.signal,
    })
    const body = (await response.json()) as {
      content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>
      error?: { message?: string }
    }
    if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`)
    let text = ''
    const toolCalls: AiToolCall[] = []
    for (const block of body.content ?? []) {
      if (block.type === 'text' && block.text) text += block.text
      if (block.type === 'tool_use' && block.name) {
        toolCalls.push({ id: block.id ?? `call-${toolCalls.length}`, name: block.name, arguments: JSON.stringify(block.input ?? {}) })
      }
    }
    if (text) onDelta(text)
    return { text: text.trim(), toolCalls }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- Gemini

function geminiContents(turns: Turn[]): unknown[] {
  return turns.map((turn) => {
    if (turn.role === 'tool') {
      return {
        role: 'user',
        parts: [{ functionResponse: { name: turn.name ?? 'tool', response: { content: turn.content } } }],
      }
    }
    if (turn.role === 'assistant') {
      const parts: unknown[] = []
      if (turn.content) parts.push({ text: turn.content })
      for (const call of turn.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: parseArgs(call.arguments) } })
      }
      return { role: 'model', parts: parts.length ? parts : [{ text: '' }] }
    }
    return { role: 'user', parts: [{ text: turn.content }] }
  })
}

async function geminiChat(
  provider: StoredProvider,
  system: string,
  turns: Turn[],
  tools: AiToolDefinition[],
  onDelta: (text: string) => void,
): Promise<{ text: string; toolCalls: AiToolCall[] }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  try {
    const url = `${provider.baseUrl}/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: geminiContents(turns),
        generationConfig: { temperature: provider.temperature, maxOutputTokens: 4096 },
        ...(tools.length
          ? {
              tools: [
                {
                  functionDeclarations: tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  })),
                },
              ],
            }
          : {}),
      }),
      signal: controller.signal,
    })
    const body = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }> } }>
      error?: { message?: string }
    }
    if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`)
    let text = ''
    const toolCalls: AiToolCall[] = []
    for (const part of body.candidates?.[0]?.content?.parts ?? []) {
      if (part.text) text += part.text
      if (part.functionCall?.name) {
        toolCalls.push({
          id: `call-${toolCalls.length}`,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        })
      }
    }
    if (text) onDelta(text)
    return { text: text.trim(), toolCalls }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- Ollama

async function ollamaChat(
  provider: StoredProvider,
  system: string,
  turns: Turn[],
  onDelta: (text: string) => void,
): Promise<{ text: string; toolCalls: AiToolCall[] }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180_000)
  try {
    const response = await fetch(`${provider.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: provider.model,
        stream: false,
        options: { temperature: provider.temperature },
        messages: [
          { role: 'system', content: system },
          ...turns.map((turn) => ({ role: turn.role === 'tool' ? 'user' : turn.role, content: turn.content })),
        ],
      }),
      signal: controller.signal,
    })
    const body = (await response.json()) as { message?: { content?: string }; error?: string }
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
    const text = body.message?.content?.trim() ?? ''
    if (text) onDelta(text)
    return { text, toolCalls: [] }
  } finally {
    clearTimeout(timer)
  }
}

async function callProvider(
  provider: StoredProvider,
  system: string,
  turns: Turn[],
  tools: AiToolDefinition[],
  onDelta: (text: string) => void,
): Promise<{ text: string; toolCalls: AiToolCall[] }> {
  if (provider.kind === 'anthropic') return anthropicChat(provider, system, turns, tools, onDelta)
  if (provider.kind === 'gemini') return geminiChat(provider, system, turns, tools, onDelta)
  if (provider.kind === 'ollama') return ollamaChat(provider, system, turns, onDelta)
  return openAIChat(provider, system, turns, tools, onDelta)
}

/**
 * One request without a conversation or tools (the 漫画 storyboard and memory):
 * the answer's text. The provider calls carry their own timeouts.
 */
export async function complete(input: { providerId?: string; system: string; prompt: string }): Promise<string> {
  const providers = load().providers
  const provider = input.providerId ? providers.find((item) => item.id === input.providerId) : providers[0]
  if (!provider) throw new Error('还没有连接语言模型，请先在助手里添加')
  const { text } = await callProvider(provider, input.system, [{ role: 'user', content: input.prompt }], [], () => undefined)
  if (!text.trim()) throw new Error('语言模型没有回答，请再试一次')
  return text
}

const MAX_TOOL_ROUNDS = 4

export async function chat(
  input: AiChatInput,
  options: {
    emit: (event: AiStreamEvent) => void
    runTool: (call: AiToolCall, mode: AgentMode) => Promise<AiToolResult>
    tools: AiToolDefinition[]
  },
): Promise<AiChatResult> {
  const store = load()
  const provider = store.providers.find((item) => item.id === input.providerId)
  if (!provider) throw new Error('请先添加 AI Provider')
  const now = new Date().toISOString()
  const existing = input.conversationId ? store.conversations.find((item) => item.id === input.conversationId) : undefined
  const conversation: AiConversationInfo = existing ?? {
    id: `chat-${randomUUID().slice(0, 8)}`,
    title: (input.message ?? '新对话').slice(0, 48) || '新对话',
    providerId: provider.id,
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
  const mode: AgentMode = input.mode ?? conversation.mode ?? 'auto'
  conversation.mode = mode

  if (input.regenerate) {
    // Drop the failed/unsatisfying assistant turn and everything after the last user turn.
    while (conversation.messages.length > 0 && conversation.messages[conversation.messages.length - 1].role !== 'user') {
      conversation.messages.pop()
    }
    if (!conversation.messages.length) throw new Error('没有可重新生成的对话')
  } else {
    // Only the new turn is appended; the stored conversation already has the rest.
    conversation.messages = [
      ...conversation.messages,
      { id: `msg-${randomUUID().slice(0, 8)}`, role: 'user', content: input.message ?? '', createdAt: now },
    ]
  }

  const system = [SYSTEM_PROMPT, MODE_RULES[mode], input.context].filter(Boolean).join('\n\n')
  const assistantId = `msg-${randomUUID().slice(0, 8)}`
  options.emit({ type: 'start', conversationId: conversation.id, messageId: assistantId })
  let streamed = ''
  let reply = ''
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const turns = toTurns(conversation.messages)
      const { text, toolCalls } = await callProvider(provider, system, turns, options.tools, (delta) => {
        streamed += delta
        options.emit({ type: 'delta', conversationId: conversation.id, messageId: assistantId, text: delta })
      })
      reply = text
      const stamp = new Date().toISOString()
      if (!toolCalls.length) {
        conversation.messages.push({ id: assistantId, role: 'assistant', content: text, createdAt: stamp })
        break
      }
      conversation.messages.push({
        id: `msg-${randomUUID().slice(0, 8)}`,
        role: 'assistant',
        content: text,
        createdAt: stamp,
        toolCalls,
      })
      const asking = conversation.messages[conversation.messages.length - 1]
      let card: AgentCard | null = null
      const steps: PlanStep[] = []
      for (const call of toolCalls) {
        options.emit({ type: 'tool', conversationId: conversation.id, call })
        const result = await options.runTool(call, mode)
        options.emit({ type: 'tool-result', conversationId: conversation.id, callId: call.id, result })
        // A tool may hand back a card to show in the chat; it belongs to the
        // assistant turn that asked, and survives a restart with it. Writes the
        // advanced mode held back are collected into one plan instead.
        card ??= cardInResult(result)
        const step = stepInResult(result)
        if (step) steps.push(step)
        conversation.messages.push({
          id: `msg-${randomUUID().slice(0, 8)}`,
          role: 'tool',
          content: result.content,
          createdAt: new Date().toISOString(),
          toolCallId: call.id,
          name: call.name,
          error: !result.ok,
        })
      }
      if (card) {
        asking.card = card
        // An ask card ends the turn: the user answers it next. Another round used
        // to call the same tool again, which duplicated the card and its trace.
        if (card.kind !== 'plan') break
      } else if (steps.length) asking.card = planCardFor(text, steps)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    options.emit({ type: 'error', conversationId: conversation.id, message })
    throw error
  }

  conversation.providerId = provider.id
  conversation.updatedAt = new Date().toISOString()
  if (!existing && conversation.messages.length > 0) {
    conversation.title = (input.message ?? conversation.title).slice(0, 48) || conversation.title
  }
  const nextStore = load()
  nextStore.conversations = [conversation, ...nextStore.conversations.filter((item) => item.id !== conversation.id)]
  save(nextStore)
  options.emit({ type: 'done', conversationId: conversation.id, conversation })
  return { reply: reply || streamed, conversation }
}

export const AI_PROVIDER_KINDS: AiProviderKind[] = ['openai', 'anthropic', 'gemini', 'ollama']

/**
 * The provider the 助手 uses now: the one of the most recent conversation, else the newest saved
 * (the panel lists providers newest first and starts on the first).
 */
export function currentProviderId(): string | null {
  const store = load()
  const recent = [...store.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  if (recent && store.providers.some((item) => item.id === recent.providerId)) return recent.providerId
  return store.providers[0]?.id ?? null
}

export interface ImageQuestion {
  system: string
  prompt: string
  image: { data: Uint8Array; mime: string }
}

/** The error code when the provider answered that it cannot read pictures, so the caller can stop asking. */
export const E_NO_IMAGE_INPUT = 'E_NO_IMAGE_INPUT'

/** Provider answers that mean "this model takes no picture" rather than a passing failure. */
const NO_IMAGE_INPUT = new RegExp(
  [
    // "does not support image input", "cannot process images", "doesn't support vision"
    String.raw`(?:does ?n[o']?t|do not|cannot|can't|unable to) (?:support|accept|process|handle|read|take) (?:image|vision|multi-?modal|picture)`,
    // "image input is not supported", "vision is not enabled for this model"
    String.raw`(?:image|vision|multi-?modal)(?: input| inputs| content| understanding)? (?:is |are )?(?:not supported|unsupported|not enabled|not available)`,
    String.raw`text[- ]only model|model (?:is|only supports?) text|unknown variant .?image_url|image_url.{0,30}(?:not supported|unsupported|unknown|invalid type)`,
  ].join('|'),
  'i',
)

function imageRequest(provider: StoredProvider, question: ImageQuestion): { url: string; headers: Record<string, string>; body: unknown } {
  const base64 = Buffer.from(question.image.data).toString('base64')
  const { mime } = question.image
  if (provider.kind === 'anthropic') {
    return {
      url: `${provider.baseUrl}/v1/messages`,
      headers: { 'content-type': 'application/json', 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' },
      body: {
        model: provider.model,
        max_tokens: 400,
        system: question.system,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
              { type: 'text', text: question.prompt },
            ],
          },
        ],
      },
    }
  }
  if (provider.kind === 'gemini') {
    return {
      url: `${provider.baseUrl}/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`,
      headers: { 'content-type': 'application/json' },
      body: {
        systemInstruction: { parts: [{ text: question.system }] },
        contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: question.prompt }] }],
        generationConfig: { maxOutputTokens: 400 },
      },
    }
  }
  if (provider.kind === 'ollama') {
    return {
      url: `${provider.baseUrl}/api/chat`,
      headers: { 'content-type': 'application/json' },
      body: {
        model: provider.model,
        stream: false,
        messages: [
          { role: 'system', content: question.system },
          { role: 'user', content: question.prompt, images: [base64] },
        ],
      },
    }
  }
  return {
    url: `${provider.baseUrl}/chat/completions`,
    headers: { 'content-type': 'application/json', ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) },
    body: {
      model: provider.model,
      max_tokens: 400,
      messages: [
        { role: 'system', content: question.system },
        {
          role: 'user',
          content: [
            { type: 'text', text: question.prompt },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
          ],
        },
      ],
    },
  }
}

function imageAnswer(kind: AiProviderKind, body: unknown): string {
  const value = body as {
    content?: Array<{ type?: string; text?: string }>
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    message?: { content?: string }
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>
  }
  if (kind === 'anthropic') return (value.content ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('')
  if (kind === 'gemini') return (value.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('')
  if (kind === 'ollama') return value.message?.content ?? ''
  const content = value.choices?.[0]?.message?.content
  return typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('')
}

function errorText(body: unknown, status: number): string {
  const value = body as { error?: { message?: string } | string; message?: string } | null
  if (typeof value?.error === 'string') return value.error
  return value?.error?.message ?? value?.message ?? `HTTP ${status}`
}

/** One picture and one question to the provider, answered as plain text (no tools, no streaming). */
export async function askAboutImage(providerId: string, question: ImageQuestion, timeoutMs = 60_000): Promise<string> {
  const provider = load().providers.find((item) => item.id === providerId)
  if (!provider) throw new Error('请先添加 AI Provider')
  const request = imageRequest(provider, question)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    })
    const text = await response.text()
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {
      // Not JSON (a proxy's error page): the status says what happened.
    }
    if (!response.ok) {
      const message = errorText(body, response.status)
      if (response.status >= 400 && response.status < 500 && NO_IMAGE_INPUT.test(message)) throw codedError(E_NO_IMAGE_INPUT, message)
      throw new Error(message)
    }
    return imageAnswer(provider.kind, body).trim()
  } finally {
    clearTimeout(timer)
  }
}
