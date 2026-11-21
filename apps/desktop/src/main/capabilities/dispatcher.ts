import type { CapabilityApprovalRequest } from '@shared/agentHub'
import { randomUUID } from 'node:crypto'
import type { AgentMode, AiToolCall, AiToolResult } from '@shared/ai'
import type { PlanStep } from '@shared/agent/cards'
import {
  BUILTIN_CAPABILITY_REGISTRY,
  isMutatingEffects,
  projectCapabilities,
  type ActionDescriptor,
  type CapabilityAuditEntry,
  type CapabilityCallSource,
  type CapabilityId,
  type CapabilityRegistry,
  type CapabilitySurface,
  type ProjectedToolset,
  type SkillAudience,
  type SynthesizedSkill,
  type ToolProfileId,
} from '@shared/capabilities'
import { recordCapabilityAudit } from './audit'

/**
 * Main-process capability dispatcher, used by external Agents over MCP (the
 * built-in 助手 keeps its own tools). It routes `target: 'main'` actions to
 * main services and `target: 'renderer'` ones to the Studio window, and
 * enforces, in this order: the caller's allowlist, feature flags, read-only
 * callers, input validation, path rules, plans, approval, then audit.
 */

export type MainCapabilityHandler = (
  args: Record<string, unknown>,
  context: {
    callId: string
    action: ActionDescriptor
    source: CapabilityCallSource
    conversationId?: string
  },
) => unknown | Promise<unknown>

export interface DispatchRequest {
  callId?: string
  name: string
  arguments?: Record<string, unknown> | string
  mode?: AgentMode
  source?: CapabilityCallSource
  conversationId?: string
  /** Canonical ids this caller may run (the MCP profile's toolset); anything else is refused. Absent: every registered action. */
  allowed?: ReadonlySet<string>
  /** Only actions that change nothing and need no approval. */
  readOnly?: boolean
  /** Aborted when the caller went away: a pending approval is dropped and nothing runs. */
  signal?: AbortSignal
  runInRenderer?: (call: AiToolCall, mode: AgentMode, conversationId?: string) => Promise<AiToolResult>
}

export interface ListCapabilitiesInput {
  profile?: ToolProfileId
  surface?: CapabilitySurface
  enabledPacks?: readonly CapabilityId[]
  excludePacks?: readonly CapabilityId[]
  headlessOnly?: boolean
  includeExternal?: boolean
  audience?: readonly SkillAudience[]
  nameStyle?: 'legacy-or-id' | 'canonical'
}

export type ApprovalHandler = (request: CapabilityApprovalRequest, signal?: AbortSignal) => Promise<boolean>

export interface MainCapabilityDispatcher {
  requestApproval?: ApprovalHandler
  readonly registry: CapabilityRegistry
  list(input?: ListCapabilitiesInput): ProjectedToolset
  skill(input?: ListCapabilitiesInput): SynthesizedSkill
  execute(request: DispatchRequest): Promise<AiToolResult>
}

export interface MainCapabilityDispatcherOptions {
  registry?: CapabilityRegistry
  mainHandlers: Readonly<Record<string, MainCapabilityHandler>>
  readFlags?: () => Readonly<Record<string, boolean>>
  runInRenderer?: (call: AiToolCall, mode: AgentMode, conversationId?: string) => Promise<AiToolResult>
  audit?: (entry: CapabilityAuditEntry) => void
  /** Checks and rewrites validated arguments before anything runs (paths an Agent names); throws to refuse. */
  prepareArgs?: (action: ActionDescriptor, args: Record<string, unknown>, source: CapabilityCallSource) => Promise<Record<string, unknown>>
  /** What the person sees in an approval beyond the arguments (the recipe and host a training run resolves to). */
  approvalDetail?: (action: ActionDescriptor, args: Record<string, unknown>) => Promise<string | undefined>
}

/** Audit summaries and errors are capped: they are read back by Agents and must not carry whole prompts or files. */
const AUDIT_TEXT_MAX = 200

function parseRawArgs(raw: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw !== 'string') return raw
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function serializeResult(data: unknown, extra?: Record<string, unknown>): AiToolResult {
  const body =
    data && typeof data === 'object' && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>), ...extra }
      : { value: data, ...extra }
  return { ok: true, content: JSON.stringify(body) }
}

function fail(error: string, extra?: Record<string, unknown>): AiToolResult {
  return { ok: false, content: JSON.stringify({ error, ...extra }) }
}

function capped(text: string): string {
  return text.length > AUDIT_TEXT_MAX ? `${text.slice(0, AUDIT_TEXT_MAX - 1)}…` : text
}

function extractError(result: AiToolResult): string | undefined {
  if (result.ok) return undefined
  try {
    const body = JSON.parse(result.content) as { error?: unknown }
    return capped(typeof body.error === 'string' ? body.error : result.content)
  } catch {
    return capped(result.content)
  }
}

/** An unknown tool is still audited, under its own (capped) name. */
function unknownAction(name: string): ActionDescriptor {
  return {
    id: capped(name) as CapabilityId,
    packId: 'unknown.tool',
    title: name,
    description: '',
    input: {},
    target: 'main',
    scope: 'session',
    effects: [],
    policyFloor: 'auto',
    requires: [],
    headless: 'supported',
  } as unknown as ActionDescriptor
}

export function createMainCapabilityDispatcher(options: MainCapabilityDispatcherOptions): MainCapabilityDispatcher {
  const registry = options.registry ?? BUILTIN_CAPABILITY_REGISTRY
  const readFlags: () => Readonly<Record<string, boolean>> = options.readFlags ?? (() => ({}))
  const audit = options.audit ?? recordCapabilityAudit

  function list(input: ListCapabilitiesInput = {}): ProjectedToolset {
    return projectCapabilities(registry, {
      profile: input.profile ?? 'atomic',
      surface: input.surface,
      enabledFlags: readFlags(),
      enabledPacks: input.enabledPacks,
      excludePacks: input.excludePacks,
      includeExternal: input.includeExternal,
      headlessOnly: input.headlessOnly,
      audience: input.audience,
      nameStyle: input.nameStyle ?? 'canonical',
    })
  }

  function skill(input: ListCapabilitiesInput = {}): SynthesizedSkill {
    return list(input).skill
  }

  async function execute(request: DispatchRequest): Promise<AiToolResult> {
    const startedAt = Date.now()
    const callId = request.callId ?? `cap-${randomUUID().slice(0, 8)}`
    const mode: AgentMode = request.mode ?? 'auto'
    const source: CapabilityCallSource = request.source ?? 'ipc'
    let approved = false
    let args = parseRawArgs(request.arguments)
    const registered = registry.getAction(request.name)

    const record = (descriptor: ActionDescriptor, result: AiToolResult): AiToolResult => {
      let summary = descriptor.title
      try {
        if (registered) summary = registry.summarizeAction(descriptor.id, args)
      } catch {
        // A summary of malformed arguments falls back to the title.
      }
      audit({
        id: callId,
        timestamp: new Date().toISOString(),
        source,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        actionId: descriptor.id,
        packId: descriptor.packId,
        target: descriptor.target,
        effects: descriptor.effects,
        policyFloor: descriptor.policyFloor,
        mode,
        approved,
        summary: capped(summary),
        ok: result.ok,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...(result.ok ? {} : { error: extractError(result) }),
      })
      return result
    }

    if (!registered) return record(unknownAction(request.name), fail(`未知工具 ${request.name}`))

    const { descriptor } = registered
    if (request.allowed && !request.allowed.has(descriptor.id)) {
      return record(descriptor, fail(`工具「${descriptor.title}」不在当前开放的工具里`))
    }
    const pack = registry.getPack(descriptor.packId)
    if (pack?.featureFlag && readFlags()[pack.featureFlag] !== true) {
      return record(descriptor, fail(`功能「${pack.title}」未开启，请先在设置 › 功能中启用`))
    }
    if (descriptor.policyFloor === 'human-only') {
      return record(descriptor, fail(`操作「${descriptor.title}」需要你在界面中手动完成`))
    }
    const mutating = isMutatingEffects(descriptor.effects)
    if (request.readOnly && (mutating || descriptor.policyFloor !== 'auto')) {
      return record(descriptor, fail(`这里只能读取，不能执行「${descriptor.title}」`))
    }

    const validated = registry.validateInput(descriptor.id, args)
    if (!validated.ok) return record(descriptor, fail(validated.error))
    args = validated.data
    if (options.prepareArgs) {
      try {
        args = await options.prepareArgs(descriptor, args, source)
      } catch (error) {
        return record(descriptor, fail(error instanceof Error ? error.message : String(error)))
      }
    }

    const summary = registry.summarizeAction(descriptor.id, args)
    // A plan (审批 / proposal-only) changes nothing, so it needs no approval; it is never applied for an external caller.
    if (mode === 'advanced' && mutating) {
      const proposed: PlanStep = { tool: request.name, args, label: summary }
      return record(descriptor, serializeResult({ proposed }))
    }

    if (descriptor.policyFloor === 'approval') {
      const approvalHandler = dispatcher.requestApproval
      if (!approvalHandler || request.signal?.aborted) {
        return record(descriptor, fail(`操作「${descriptor.title}」需要你的确认后才能执行`, { requiresApproval: true }))
      }
      try {
        const detail = await options.approvalDetail?.(descriptor, args).catch(() => undefined)
        approved = await approvalHandler(
          {
            actionId: descriptor.id,
            packId: descriptor.packId,
            title: descriptor.title,
            summary: detail ? `${summary}\n${detail}` : summary,
            argsPreview: JSON.stringify(args).slice(0, 2000),
            source,
          },
          request.signal,
        )
      } catch {
        // Approval failures must never authorize an operation.
        approved = false
      }
      if (!approved || request.signal?.aborted) {
        approved = false
        return record(descriptor, fail('操作未获批准', { requiresApproval: true }))
      }
    }

    if (descriptor.target === 'renderer') {
      const runner = request.runInRenderer ?? options.runInRenderer
      if (!runner) return record(descriptor, fail('Studio 窗口尚未就绪，请先打开创作页'))
      try {
        const result = await runner({ id: callId, name: request.name, arguments: JSON.stringify(args) }, mode, request.conversationId)
        return record(descriptor, result)
      } catch (error) {
        return record(descriptor, fail(error instanceof Error ? error.message : String(error)))
      }
    }

    const handler = options.mainHandlers[descriptor.id]
    if (!handler) return record(descriptor, fail(`能力 ${descriptor.title} 尚未绑定主进程处理器`))
    try {
      const data = await handler(args, { callId, action: descriptor, source, conversationId: request.conversationId })
      return record(descriptor, mutating ? serializeResult(data, { summary }) : serializeResult(data))
    } catch (error) {
      return record(descriptor, fail(error instanceof Error ? error.message : String(error)))
    }
  }

  const dispatcher: MainCapabilityDispatcher = {
    registry,
    list,
    skill,
    execute,
  }
  return dispatcher
}
