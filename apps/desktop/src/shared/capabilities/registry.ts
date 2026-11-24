import type { ZodError, z } from 'zod'
import type { AiToolDefinition } from '../ai'
import {
  CAPABILITY_PROTOCOL_VERSION,
  descriptorFromContribution,
  isCapabilityId,
  packDescriptorFromBuiltin,
  packFromExternalManifest,
  sha256Text,
  type ActionDescriptor,
  type ActionEffect,
  type ActionTarget,
  type BuiltinActionContribution,
  type BuiltinCapabilityPack,
  type CapabilityId,
  type CapabilityPack,
  type CapabilitySurface,
  type DiscoveredExternalTool,
  type ExternalToolManifest,
  type LegacyAgentPack,
  type PolicyGate,
  type SkillAudience,
  type SkillFragment,
} from './protocol'

/**
 * Capability registry: one source of truth for built-in Studio packs and
 * external manifest packs. Validates uniqueness, filters by surface/flags,
 * validates tool arguments and synthesizes matching Markdown skills.
 */

export interface RegisteredAction {
  descriptor: ActionDescriptor
  legacyPack?: LegacyAgentPack
  inputSchema?: z.ZodType
  summarize?: (args: Record<string, unknown>) => string
}

export interface CapabilityQuery {
  /** Active UI surface; actions with a different `surface` are omitted unless unset. */
  surface?: CapabilitySurface
  /** Optional feature flags (`{ gbcEnabled: true }`); missing flags default to false. */
  enabledFlags?: Readonly<Record<string, boolean>>
  /** Explicit pack allowlist; when omitted every active pack is included. */
  enabledPacks?: readonly CapabilityId[]
  /** Include packs registered from ExternalToolManifest (default true). */
  includeExternal?: boolean
  /** Exclude any action carrying one of these effects (e.g. `['write', 'run', 'delete']`). */
  excludeEffects?: readonly ActionEffect[]
  /** Maximum policy gate allowed in this projection (`auto` < `approval` < `human-only`). */
  maxPolicyGate?: PolicyGate
  /** Only return actions marked `headless: 'supported'`. */
  headlessOnly?: boolean
  /** Filter by execution target (`main`, `renderer`, `hybrid`). */
  targets?: readonly ActionTarget[]
  /** Explicit action id / legacyAlias allowlist. */
  ids?: readonly string[]
}

export interface SkillSynthesisOptions {
  surface?: CapabilitySurface
  enabledFlags?: Readonly<Record<string, boolean>>
  enabledPacks?: readonly CapabilityId[]
  includeExternal?: boolean
  audience?: readonly SkillAudience[]
  /** Pre-resolved actions; when provided, `surface`/`enabledPacks` filtering is skipped. */
  actions?: readonly ActionDescriptor[]
  heading?: string
}

export interface SynthesizedSkill {
  markdown: string
  fragmentIds: CapabilityId[]
  actionIds: CapabilityId[]
  digest: string
}

export interface ToolDefinitionOptions {
  /** `legacy-or-id` preserves `studio_*` aliases for existing callers; `canonical` always uses dotted ids. */
  nameStyle?: 'legacy-or-id' | 'canonical'
}

export type ValidationResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: string }

export interface CapabilityRegistry {
  registerBuiltinPack(pack: BuiltinCapabilityPack): void
  registerPack(pack: CapabilityPack): void
  registerExternalManifest(manifest: ExternalToolManifest, discovered?: Readonly<Record<string, DiscoveredExternalTool>>): CapabilityPack
  unregisterPack(packId: CapabilityId): boolean
  getPack(packId: CapabilityId): CapabilityPack | undefined
  listPacks(filter?: Pick<CapabilityQuery, 'enabledFlags' | 'includeExternal'>): CapabilityPack[]
  listActions(query?: CapabilityQuery): ActionDescriptor[]
  getAction(idOrAlias: string): RegisteredAction | undefined
  listLegacyActions(): RegisteredAction[]
  validateInput(idOrAlias: string, raw: Record<string, unknown>): ValidationResult
  summarizeAction(idOrAlias: string, args: Record<string, unknown>): string
  toToolDefinitions(actions?: readonly ActionDescriptor[], options?: ToolDefinitionOptions): AiToolDefinition[]
  synthesizeSkill(options?: SkillSynthesisOptions): SynthesizedSkill
}

const POLICY_RANK: Record<PolicyGate, number> = {
  auto: 0,
  approval: 1,
  'human-only': 2,
}

const ISSUE_REASONS: Record<string, string> = {
  invalid_type: '类型不对',
  too_small: '太短或太小',
  too_big: '太长或太大',
  invalid_value: '取值不对',
  unrecognized_keys: '多了不认识的字段',
}

/** A schema failure in words the model (and the tool line) can act on. */
export function explainZodIssues(error: ZodError): string {
  const issue = error.issues[0]
  if (!issue) return '参数不对'
  const path = issue.path.join('.')
  const reason = ISSUE_REASONS[issue.code] ?? issue.message
  return path ? `参数不对：${path} ${reason}` : `参数不对：${reason}`
}

function validateAgainstJsonSchema(schema: Readonly<Record<string, unknown>>, raw: Record<string, unknown>): ValidationResult {
  const properties = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {}
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
  for (const key of required) {
    if (raw[key] === undefined) return { ok: false, error: `参数不对：${key} 类型不对` }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(raw)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        return { ok: false, error: `参数不对：${key} 多了不认识的字段` }
      }
    }
  }
  return { ok: true, data: raw }
}

interface StoredPack {
  descriptor: CapabilityPack
  external: boolean
  actions: RegisteredAction[]
}

function assertValidPackDescriptor(pack: CapabilityPack): void {
  if (pack.protocolVersion !== CAPABILITY_PROTOCOL_VERSION) {
    throw new Error(`Unsupported capability protocolVersion: ${String(pack.protocolVersion)}`)
  }
  if (!isCapabilityId(pack.id)) {
    throw new Error(`Invalid capability pack id: ${pack.id}`)
  }
  if (!pack.title.trim()) {
    throw new Error(`Capability pack ${pack.id} must have a non-empty title`)
  }
  for (const action of pack.actions) {
    if (!isCapabilityId(action.id)) {
      throw new Error(`Invalid action id: ${action.id}`)
    }
    if (action.packId !== pack.id) {
      throw new Error(`Action ${action.id} packId (${action.packId}) does not match pack ${pack.id}`)
    }
    if (!action.title.trim() || !action.description.trim()) {
      throw new Error(`Action ${action.id} must have a non-empty title and description`)
    }
  }
}

export function createCapabilityRegistry(initialPacks: readonly (BuiltinCapabilityPack | CapabilityPack)[] = []): CapabilityRegistry {
  const packs = new Map<CapabilityId, StoredPack>()
  const byId = new Map<string, RegisteredAction>()
  const byAlias = new Map<string, RegisteredAction>()

  function registerStored(stored: StoredPack): void {
    const { descriptor } = stored
    assertValidPackDescriptor(descriptor)
    if (packs.has(descriptor.id)) {
      throw new Error(`Capability pack already registered: ${descriptor.id}`)
    }
    // Check collisions before mutating maps so a rejected pack leaves no partial state.
    const seenIds = new Set<string>()
    const seenAliases = new Set<string>()
    for (const entry of stored.actions) {
      const { id, legacyAlias } = entry.descriptor
      if (seenIds.has(id) || byId.has(id) || byAlias.has(id)) {
        throw new Error(`Duplicate capability action id: ${id}`)
      }
      seenIds.add(id)
      if (legacyAlias) {
        if (seenAliases.has(legacyAlias) || byAlias.has(legacyAlias) || byId.has(legacyAlias)) {
          throw new Error(`Duplicate capability legacyAlias: ${legacyAlias}`)
        }
        seenAliases.add(legacyAlias)
      }
    }
    packs.set(descriptor.id, stored)
    for (const entry of stored.actions) {
      byId.set(entry.descriptor.id, entry)
      if (entry.descriptor.legacyAlias) byAlias.set(entry.descriptor.legacyAlias, entry)
    }
  }

  function registerBuiltinPack(pack: BuiltinCapabilityPack): void {
    const descriptor = packDescriptorFromBuiltin(pack)
    const actions: RegisteredAction[] = pack.actions.map((contribution: BuiltinActionContribution) => ({
      descriptor: descriptorFromContribution(pack.id, contribution),
      legacyPack: contribution.legacyPack,
      inputSchema: contribution.inputSchema,
      summarize: contribution.summarize,
    }))
    registerStored({ descriptor, external: false, actions })
  }

  function registerPack(pack: CapabilityPack): void {
    const external = pack.actions.some((action) => action.binding.kind === 'external')
    const actions: RegisteredAction[] = pack.actions.map((descriptor) => ({ descriptor }))
    registerStored({ descriptor: pack, external, actions })
  }

  function registerExternalManifest(
    manifest: ExternalToolManifest,
    discovered?: Readonly<Record<string, DiscoveredExternalTool>>,
  ): CapabilityPack {
    const pack = packFromExternalManifest(manifest, discovered)
    registerStored({
      descriptor: pack,
      external: true,
      actions: pack.actions.map((descriptor) => ({ descriptor })),
    })
    return pack
  }

  function unregisterPack(packId: CapabilityId): boolean {
    const stored = packs.get(packId)
    if (!stored) return false
    packs.delete(packId)
    for (const entry of stored.actions) {
      byId.delete(entry.descriptor.id)
      if (entry.descriptor.legacyAlias) byAlias.delete(entry.descriptor.legacyAlias)
    }
    return true
  }

  function activePacks(filter: Pick<CapabilityQuery, 'enabledFlags' | 'enabledPacks' | 'includeExternal'> = {}): StoredPack[] {
    const allowPacks = filter.enabledPacks ? new Set(filter.enabledPacks) : null
    const flags = filter.enabledFlags ?? {}
    const includeExternal = filter.includeExternal !== false
    const activeIds = new Set<CapabilityId>()

    const candidates = [...packs.values()].filter((stored) => {
      if (!includeExternal && stored.external) return false
      if (allowPacks && !allowPacks.has(stored.descriptor.id)) return false
      if (stored.descriptor.featureFlag && flags[stored.descriptor.featureFlag] !== true) return false
      activeIds.add(stored.descriptor.id)
      return true
    })

    // Drop packs whose required dependency packs are not active.
    let changed = true
    let resolved = candidates
    while (changed) {
      changed = false
      const next: StoredPack[] = []
      for (const stored of resolved) {
        if (stored.descriptor.requiresPacks.every((req) => activeIds.has(req))) {
          next.push(stored)
        } else {
          activeIds.delete(stored.descriptor.id)
          changed = true
        }
      }
      resolved = next
    }
    return resolved
  }

  function listPacks(filter: Pick<CapabilityQuery, 'enabledFlags' | 'includeExternal'> = {}): CapabilityPack[] {
    return activePacks(filter).map((stored) => stored.descriptor)
  }

  function listActions(query: CapabilityQuery = {}): ActionDescriptor[] {
    const excludeEffects = query.excludeEffects ? new Set(query.excludeEffects) : null
    const maxPolicyRank = query.maxPolicyGate ? POLICY_RANK[query.maxPolicyGate] : null
    const targetSet = query.targets ? new Set(query.targets) : null
    const idSet = query.ids ? new Set(query.ids) : null

    const out: ActionDescriptor[] = []
    for (const stored of activePacks(query)) {
      for (const { descriptor } of stored.actions) {
        if (query.surface && descriptor.surface && descriptor.surface !== query.surface) continue
        if (excludeEffects && descriptor.effects.some((effect) => excludeEffects.has(effect))) continue
        if (maxPolicyRank !== null && POLICY_RANK[descriptor.policyFloor] > maxPolicyRank) continue
        if (query.headlessOnly && descriptor.headless !== 'supported') continue
        if (targetSet && !targetSet.has(descriptor.target)) continue
        if (idSet && !idSet.has(descriptor.id) && !(descriptor.legacyAlias && idSet.has(descriptor.legacyAlias))) continue
        out.push(descriptor)
      }
    }
    return out
  }

  function getAction(idOrAlias: string): RegisteredAction | undefined {
    return byId.get(idOrAlias) ?? byAlias.get(idOrAlias)
  }

  function listLegacyActions(): RegisteredAction[] {
    const out: RegisteredAction[] = []
    for (const stored of packs.values()) {
      for (const entry of stored.actions) {
        if (entry.descriptor.legacyAlias) out.push(entry)
      }
    }
    return out
  }

  function validateInput(idOrAlias: string, raw: Record<string, unknown>): ValidationResult {
    const entry = getAction(idOrAlias)
    if (!entry) return { ok: false, error: `未知工具 ${idOrAlias}` }
    if (entry.inputSchema) {
      const parsed = entry.inputSchema.safeParse(raw)
      if (!parsed.success) return { ok: false, error: explainZodIssues(parsed.error) }
      return { ok: true, data: parsed.data as Record<string, unknown> }
    }
    return validateAgainstJsonSchema(entry.descriptor.input, raw)
  }

  function summarizeAction(idOrAlias: string, args: Record<string, unknown>): string {
    const entry = getAction(idOrAlias)
    if (!entry) return idOrAlias
    if (entry.summarize) return entry.summarize(args)
    return entry.descriptor.summarizeLabel ?? entry.descriptor.title
  }

  function toToolDefinitions(actions?: readonly ActionDescriptor[], options: ToolDefinitionOptions = {}): AiToolDefinition[] {
    const list = actions ?? listActions()
    const style = options.nameStyle ?? 'legacy-or-id'
    return list.map((action) => ({
      name: style === 'legacy-or-id' ? (action.legacyAlias ?? action.id) : action.id,
      description: action.description,
      inputSchema: { ...action.input },
    }))
  }

  function synthesizeSkill(options: SkillSynthesisOptions = {}): SynthesizedSkill {
    const actions =
      options.actions ??
      listActions({
        surface: options.surface,
        enabledFlags: options.enabledFlags,
        enabledPacks: options.enabledPacks,
        includeExternal: options.includeExternal,
      })
    const activeActionIds = new Set<CapabilityId>(actions.map((action) => action.id))
    const audienceFilter = options.audience?.length ? new Set(options.audience) : null
    // A guide-only pack adds its text to every request, so it counts only when the person picked it by name.
    const pickedPacks = new Set(options.enabledPacks ?? [])

    const fragments: SkillFragment[] = []
    for (const stored of packs.values()) {
      if (GUIDE_ONLY_PACKS.has(stored.descriptor.id) && !pickedPacks.has(stored.descriptor.id)) continue
      for (const fragment of stored.descriptor.skills) {
        if (!fragment.requiresActions.every((requiredId) => activeActionIds.has(requiredId))) continue
        if (audienceFilter && !fragment.audience.some((item) => audienceFilter.has(item))) continue
        fragments.push(fragment)
      }
    }
    fragments.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))

    const heading = options.heading?.trim() || '# MossStudio Active Workbench Skill'
    const body = fragments.map((fragment) => fragment.markdown.trim()).filter(Boolean)
    const markdown = body.length ? `${heading}\n\n${body.join('\n\n')}\n` : `${heading}\n`
    return {
      markdown,
      fragmentIds: fragments.map((fragment) => fragment.id),
      actionIds: actions.map((action) => action.id),
      digest: sha256Text(markdown),
    }
  }

  for (const pack of initialPacks) {
    if (isBuiltinPack(pack)) registerBuiltinPack(pack)
    else registerPack(pack)
  }

  return {
    registerBuiltinPack,
    registerPack,
    registerExternalManifest,
    unregisterPack,
    getPack: (packId) => packs.get(packId)?.descriptor,
    listPacks,
    listActions,
    getAction,
    listLegacyActions,
    validateInput,
    summarizeAction,
    toToolDefinitions,
    synthesizeSkill,
  }
}

/** Built-in packs that carry only a Skill guide and no actions. */
const GUIDE_ONLY_PACKS: ReadonlySet<CapabilityId> = new Set(['skill.moss.standard', 'skill.moss.layout'])

function isBuiltinPack(pack: BuiltinCapabilityPack | CapabilityPack): pack is BuiltinCapabilityPack {
  const first = pack.actions[0]
  return first ? 'inputSchema' in first : GUIDE_ONLY_PACKS.has(pack.id)
}
