import type { AgentMode, AiToolCall, AiToolResult } from '@shared/ai'
import type { PlanStep } from '@shared/agent/cards'
import {
  BUILTIN_CAPABILITY_REGISTRY,
  isMutatingEffects,
  type ActionDescriptor,
  type CapabilityId,
  type CapabilityQuery,
  type CapabilityRegistry,
} from '@shared/capabilities'
import type { ProjectCanvas } from '@shared/types'

/**
 * Runs capability actions (`studio.cards.create`, …) that target the renderer.
 *
 * Packs register their handlers while the page that owns the state is mounted.
 * Every call passes the same precheck, schema validation, advanced-mode
 * deferral and problem report as the built-in assistant's tools, so an
 * external Agent reaching the board over MCP gets the same answers.
 */

export interface HostSelectionState {
  hasSelection: boolean
  editable: boolean
  selectedKind?: ProjectCanvas['kind']
}

export interface CapabilityExecutionContext {
  callId: string
  action: ActionDescriptor
  mode?: AgentMode
  conversationId?: string
}

export type CapabilityHandler = (args: Record<string, unknown>, context: CapabilityExecutionContext) => unknown

export interface PackRegistrationOptions {
  /** Live selection probe for actions that need an editable card. */
  checkState?: () => HostSelectionState
  /** What the selected card still lacks, reported after a change. */
  readProblems?: () => string[]
}

/** A capability refusing to run for a reason the caller can act on. */
export class CapabilityFailure extends Error {
  constructor(
    message: string,
    readonly fix?: { tool: string; args?: Record<string, unknown> },
  ) {
    super(message)
  }
}

export interface ExecuteCapabilityOptions {
  mode?: AgentMode
  conversationId?: string
}

export interface RendererCapabilityHost {
  readonly registry: CapabilityRegistry
  registerPackHandlers(
    packId: CapabilityId,
    handlers: Readonly<Record<string, CapabilityHandler>>,
    options?: PackRegistrationOptions,
  ): () => void
  hasHandler(idOrAlias: string): boolean
  listActiveActions(query?: CapabilityQuery): ActionDescriptor[]
  execute(call: AiToolCall, options?: ExecuteCapabilityOptions): Promise<AiToolResult>
}

interface MountedHandler {
  token: symbol
  handler: CapabilityHandler
  options: PackRegistrationOptions
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function ok(data: unknown, extra?: Record<string, unknown>): AiToolResult {
  const body =
    data && typeof data === 'object' && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>), ...extra }
      : { value: data, ...extra }
  return { ok: true, content: JSON.stringify(body) }
}

function fail(error: string, fix?: { tool: string; args?: Record<string, unknown> }): AiToolResult {
  return { ok: false, content: JSON.stringify(fix ? { error, fix } : { error }) }
}

export function isMutatingAction(descriptor: ActionDescriptor): boolean {
  return isMutatingEffects(descriptor.effects)
}

function precheck(descriptor: ActionDescriptor, checkState?: () => HostSelectionState): AiToolResult | null {
  const needsEditable = descriptor.requires.includes('editable')
  const needsEditableOrStyle = descriptor.requires.includes('editable-or-style')
  if ((!needsEditable && !needsEditableOrStyle) || !checkState) return null
  const state = checkState()
  if (!state.hasSelection) return fail('先在画布上选中一个画面')
  if (needsEditable && !state.editable) return fail('选中的是生成结果，不能修改；请先复制成新画面')
  if (needsEditableOrStyle && !state.editable && state.selectedKind !== 'style') return fail('选中的是生成结果，不能修改；请先复制成新画面')
  return null
}

function problemsOf(readProblems?: () => string[]): string[] {
  if (!readProblems) return []
  try {
    return readProblems()
  } catch {
    return []
  }
}

export function createRendererCapabilityHost(registry: CapabilityRegistry = BUILTIN_CAPABILITY_REGISTRY): RendererCapabilityHost {
  const mounted = new Map<CapabilityId, MountedHandler>()

  function registerPackHandlers(
    packId: CapabilityId,
    handlers: Readonly<Record<string, CapabilityHandler>>,
    options: PackRegistrationOptions = {},
  ): () => void {
    const token = Symbol(packId)
    const ids: CapabilityId[] = []
    for (const [idOrAlias, handler] of Object.entries(handlers)) {
      const action = registry.getAction(idOrAlias)
      if (!action) throw new Error(`Cannot register a handler for an unknown capability: ${idOrAlias}`)
      if (action.descriptor.packId !== packId) throw new Error(`${action.descriptor.id} does not belong to ${packId}`)
      mounted.set(action.descriptor.id, { token, handler, options })
      ids.push(action.descriptor.id)
    }
    return () => {
      // A later registration of the same action (a remount) stays.
      for (const id of ids) if (mounted.get(id)?.token === token) mounted.delete(id)
    }
  }

  function resolve(idOrAlias: string): { descriptor: ActionDescriptor; entry: MountedHandler | undefined } | null {
    const registered = registry.getAction(idOrAlias)
    if (!registered) return null
    return { descriptor: registered.descriptor, entry: mounted.get(registered.descriptor.id) }
  }

  async function execute(call: AiToolCall, options: ExecuteCapabilityOptions = {}): Promise<AiToolResult> {
    const resolved = resolve(call.name)
    if (!resolved) return fail(`未知工具 ${call.name}`)
    const { descriptor, entry } = resolved
    if (!entry) {
      return fail(descriptor.id.startsWith('studio.') ? 'Studio 尚未就绪，请先在创作页打开一个项目' : `能力 ${descriptor.title} 尚未就绪`)
    }
    const raw = parseArguments(call.arguments)
    if (descriptor.id === 'studio.regions.add' && raw.label === 'text') {
      return fail('文字区域请用 studio_add_text_layer：caption 写样式，text 写要显示的文字', { tool: 'studio_add_text_layer' })
    }
    try {
      const blocked = precheck(descriptor, entry.options.checkState)
      if (blocked) return blocked
      const validated = registry.validateInput(descriptor.id, raw)
      if (!validated.ok) return fail(validated.error)
      const args = validated.data
      const mutating = isMutatingAction(descriptor)
      const summary = registry.summarizeAction(descriptor.id, args)
      if (options.mode === 'advanced' && mutating) {
        return ok({ proposed: { tool: call.name, args, label: summary } satisfies PlanStep })
      }
      const context: CapabilityExecutionContext = {
        callId: call.id,
        action: descriptor,
        mode: options.mode,
        conversationId: options.conversationId,
      }
      const data = await entry.handler(args, context)
      if (descriptor.effects.includes('interact')) return ok(data, { summary })
      if (!mutating) return ok(data)
      return ok(data, { summary, problems: problemsOf(entry.options.readProblems) })
    } catch (error) {
      if (error instanceof CapabilityFailure) return fail(error.message, error.fix)
      return fail(error instanceof Error ? error.message : String(error))
    }
  }

  return {
    registry,
    registerPackHandlers,
    hasHandler: (idOrAlias) => Boolean(resolve(idOrAlias)?.entry),
    listActiveActions: (query) => registry.listActions(query).filter((action) => mounted.has(action.id)),
    execute,
  }
}

/** The host the Studio registers its packs on and the tool bridge calls into. */
export const RENDERER_CAPABILITY_HOST = createRendererCapabilityHost()
