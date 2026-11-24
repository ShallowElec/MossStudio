import type { AgentMode, AiToolDefinition } from '../ai'
import {
  MUTATING_EFFECTS,
  type ActionDescriptor,
  type ActionEffect,
  type ActionTarget,
  type CapabilityId,
  type CapabilitySurface,
  type PolicyGate,
  type SkillAudience,
} from './protocol'
import type { CapabilityRegistry, SynthesizedSkill } from './registry'

/**
 * Tool Profile projection and capability audit trail contracts.
 *
 * One registry projects tailored toolsets and matching Markdown skills for
 * different agents and safety postures without duplicating tool definitions.
 */

export type ToolProfileId = 'compact' | 'moss-standard' | 'moss-layout' | 'atomic' | 'proposal-only' | 'custom'

export interface ToolProfileOptions {
  profile: ToolProfileId
  surface?: CapabilitySurface
  enabledFlags?: Readonly<Record<string, boolean>>
  enabledPacks?: readonly CapabilityId[]
  /** Packs left out whatever the profile says (the ask cards, which only the 助手's chat shows). */
  excludePacks?: readonly CapabilityId[]
  includeExternal?: boolean
  headlessOnly?: boolean
  audience?: readonly SkillAudience[]
  nameStyle?: 'legacy-or-id' | 'canonical'
}

export interface ProjectedToolset {
  profile: ToolProfileId
  actions: ActionDescriptor[]
  tools: AiToolDefinition[]
  skill: SynthesizedSkill
}

export const COMPACT_PROFILE_PACKS: readonly CapabilityId[] = [
  'studio.board.read',
  'studio.ask',
  'studio.board.cards',
  'studio.board.regions',
  'studio.board.sampling',
  'studio.board.wires',
  'studio.board.runs',
  'studio.projects',
  'models.catalog',
  'library.assets',
  'system.runtime',
  'remote.hosts',
]

export const MOSS_STANDARD_PROFILE_PACKS: readonly CapabilityId[] = [
  'studio.board.read',
  'studio.ask',
  'studio.board.cards',
  'studio.board.sampling',
  'studio.board.wires',
  'studio.board.runs',
  'studio.projects',
  'models.catalog',
  'library.assets',
  'system.runtime',
  'remote.hosts',
  'skill.moss.standard',
]

export const MOSS_LAYOUT_PROFILE_PACKS: readonly CapabilityId[] = [
  'studio.board.read',
  'studio.ask',
  'studio.board.cards',
  'studio.board.regions',
  'studio.board.sampling',
  'studio.board.wires',
  'studio.board.runs',
  'studio.projects',
  'models.catalog',
  'library.assets',
  'system.runtime',
  'remote.hosts',
  'skill.moss.standard',
  'skill.moss.layout',
]

function presetPacksForProfile(profile: ToolProfileId): readonly CapabilityId[] | undefined {
  if (profile === 'compact') return COMPACT_PROFILE_PACKS
  if (profile === 'moss-standard') return MOSS_STANDARD_PROFILE_PACKS
  if (profile === 'moss-layout') return MOSS_LAYOUT_PROFILE_PACKS
  return undefined
}

/** Project actions, provider tool schemas and synchronized Skill markdown for a Tool Profile. */
export function projectCapabilities(registry: CapabilityRegistry, options: ToolProfileOptions): ProjectedToolset {
  const effectivePacks = options.enabledPacks ?? presetPacksForProfile(options.profile)
  const listed = registry.listActions({
    surface: options.surface,
    enabledFlags: options.enabledFlags,
    enabledPacks: effectivePacks,
    includeExternal: options.includeExternal,
    headlessOnly: options.headlessOnly,
    ...(options.profile === 'proposal-only' ? { excludeEffects: MUTATING_EFFECTS } : {}),
  })
  const actions = options.excludePacks?.length ? listed.filter((action) => !options.excludePacks!.includes(action.packId)) : listed
  const tools = registry.toToolDefinitions(actions, { nameStyle: options.nameStyle ?? 'canonical' })
  const skill = registry.synthesizeSkill({
    actions,
    enabledPacks: effectivePacks,
    audience: options.audience,
  })
  return {
    profile: options.profile,
    actions,
    tools,
    skill,
  }
}

export type CapabilityCallSource = 'assistant' | 'ipc' | 'external-agent' | 'system'

/** Append-only audit record emitted for every capability execution (no secrets). */
export interface CapabilityAuditEntry {
  id: string
  timestamp: string
  source: CapabilityCallSource
  conversationId?: string
  actionId: CapabilityId
  packId: CapabilityId
  target: ActionTarget
  effects: readonly ActionEffect[]
  policyFloor: PolicyGate
  mode: AgentMode
  approved: boolean
  summary: string
  ok: boolean
  durationMs: number
  error?: string
}

export interface CapabilityAuditQuery {
  limit?: number
  /** Only calls from this kind of caller (an Agent reading the trail sees external Agents' calls only). */
  source?: CapabilityCallSource
  conversationId?: string
  packId?: string
  actionId?: string
}
