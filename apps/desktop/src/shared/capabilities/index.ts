export {
  CAPABILITY_ID_PATTERN,
  CAPABILITY_PROTOCOL_VERSION,
  canonicalJson,
  capabilityIdSchema,
  descriptorFromContribution,
  externalToolManifestSchema,
  isCapabilityId,
  isMutatingEffects,
  MUTATING_EFFECTS,
  packDescriptorFromBuiltin,
  packFromExternalManifest,
  schemaDigest,
  sha256Text,
  toClosedJsonSchema,
  type ActionBinding,
  type ActionDescriptor,
  type ActionEffect,
  type ActionRequirement,
  type ActionScope,
  type ActionTarget,
  type BuiltinActionContribution,
  type BuiltinCapabilityPack,
  type CapabilityId,
  type CapabilityPack,
  type CapabilitySurface,
  type ContextProviderDescriptor,
  type DiscoveredExternalTool,
  type ExternalToolAllowEntry,
  type ExternalToolManifest,
  type Json,
  type JsonSchema,
  type LegacyAgentPack,
  type PolicyGate,
  type SkillAudience,
  type SkillFragment,
} from './protocol'

export {
  createCapabilityRegistry,
  explainZodIssues,
  type CapabilityQuery,
  type CapabilityRegistry,
  type RegisteredAction,
  type SkillSynthesisOptions,
  type SynthesizedSkill,
  type ToolDefinitionOptions,
  type ValidationResult,
} from './registry'

export {
  LEGACY_TOOL_ORDER,
  STUDIO_ACTION_SCHEMAS,
  STUDIO_CAPABILITY_PACKS,
  createStudioCapabilityRegistry,
  type StudioActionArgs,
  type StudioActionId,
} from './studioPacks'

export { APP_ACTION_SCHEMAS, APP_CAPABILITY_PACKS, type AppActionArgs, type AppActionId } from './appPacks'

export { MOSS_LAYOUT_DESIGN_SKILL_MD, MOSS_PROMPTCRAFT_SKILL_MD, composeOfficialGuide, type GuideTopic } from './officialSkills'

export {
  projectCapabilities,
  type CapabilityAuditEntry,
  type CapabilityAuditQuery,
  type CapabilityCallSource,
  type ProjectedToolset,
  type ToolProfileId,
  type ToolProfileOptions,
} from './profiles'

import { APP_CAPABILITY_PACKS } from './appPacks'
import { createCapabilityRegistry, type CapabilityRegistry } from './registry'
import { STUDIO_CAPABILITY_PACKS } from './studioPacks'

/** Every built-in MossStudio capability pack across Studio, GBC, Library, Models, Manga, Training and System. */
export const ALL_CAPABILITY_PACKS = [...STUDIO_CAPABILITY_PACKS, ...APP_CAPABILITY_PACKS] as const

/** Create a fresh registry pre-loaded with every built-in MossStudio capability pack. */
export function createBuiltinCapabilityRegistry(): CapabilityRegistry {
  return createCapabilityRegistry(ALL_CAPABILITY_PACKS)
}

/** Default shared registry containing every built-in MossStudio capability pack. */
export const BUILTIN_CAPABILITY_REGISTRY = createBuiltinCapabilityRegistry()
