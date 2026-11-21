import { z } from 'zod'

/**
 * Capability Contribution Protocol v1.
 *
 * Transport-independent descriptors for actions, context providers, skill
 * fragments and external tool manifests. Shared across main and renderer with
 * zero Electron, Node or DOM dependencies so built-in modules and future
 * external connectors describe capabilities through one contract.
 */

export const CAPABILITY_PROTOCOL_VERSION = 1 as const

/** Dotted capability identifier such as `studio.board.read_context`. */
export const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9_-]*)+$/

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonSchema = Readonly<Record<string, unknown>>
export type CapabilityId = `${string}.${string}`

export type ActionTarget = 'main' | 'renderer' | 'hybrid'
export type ActionScope = 'session' | 'project' | 'application'
export type ActionEffect = 'read' | 'select' | 'write' | 'run' | 'delete' | 'export' | 'install' | 'configure' | 'interact'

/** Effects that change something: held as a plan in 审批/proposal-only, never run by a read-only caller. One list for main, renderer and MCP. */
export const MUTATING_EFFECTS: readonly ActionEffect[] = ['write', 'run', 'delete', 'export', 'install', 'configure']

/** Whether an action with these effects changes anything. */
export function isMutatingEffects(effects: readonly ActionEffect[]): boolean {
  return effects.some((effect) => MUTATING_EFFECTS.includes(effect))
}
export type PolicyGate = 'auto' | 'approval' | 'human-only'
export type ActionRequirement = 'selection' | 'editable' | 'editable-or-style' | 'surface' | 'engine'
export type CapabilitySurface = '/studio' | '/manga' | '/library' | '/models' | '/training'
export type SkillAudience = 'tools' | 'resources' | 'images' | 'text-only'

/** Legacy pack names kept for compatibility with the built-in Studio assistant. */
export type LegacyAgentPack = 'canvas.read' | 'canvas.write' | 'ask' | 'storyboard' | 'library'

export type ActionBinding = { kind: 'builtin'; handlerId: CapabilityId } | { kind: 'external'; sourceId: CapabilityId; remoteName: string }

export interface ActionDescriptor {
  id: CapabilityId
  /** Existing snake_case tool name when this action supersedes a legacy tool. */
  legacyAlias?: string
  version: number
  packId: CapabilityId
  /** Short Chinese label shown in chat traces and approval UI. */
  title: string
  /** English description sent to language models and external agents. */
  description: string
  input: JsonSchema
  output: JsonSchema
  target: ActionTarget
  scope: ActionScope
  surface?: CapabilitySurface
  effects: readonly ActionEffect[]
  policyFloor: PolicyGate
  requires: readonly ActionRequirement[]
  headless: 'supported' | 'requires-ui'
  summarizeLabel?: string
  binding: ActionBinding
}

export interface ContextProviderDescriptor {
  id: CapabilityId
  description: string
  scope: ActionScope
  target: ActionTarget
  output: JsonSchema
  maxBytes: number
  binding: ActionBinding
}

export interface SkillFragment {
  id: CapabilityId
  requiresActions: readonly CapabilityId[]
  order: number
  audience: readonly SkillAudience[]
  markdown: string
}

export interface CapabilityPack {
  protocolVersion: 1
  id: CapabilityId
  title: string
  version: string
  featureFlag?: string
  requiresPacks: readonly CapabilityId[]
  actions: readonly ActionDescriptor[]
  contexts: readonly ContextProviderDescriptor[]
  skills: readonly SkillFragment[]
}

/** Built-in action contribution carrying its runtime Zod schema and chat summarizer. */
export interface BuiltinActionContribution {
  id: CapabilityId
  legacyAlias?: string
  legacyPack?: LegacyAgentPack
  version?: number
  title: string
  description: string
  inputSchema: z.ZodType
  outputSchema?: JsonSchema
  target: ActionTarget
  scope: ActionScope
  surface?: CapabilitySurface
  effects: readonly ActionEffect[]
  policyFloor: PolicyGate
  requires: readonly ActionRequirement[]
  headless: 'supported' | 'requires-ui'
  summarizeLabel?: string
  summarize(args: Record<string, unknown>): string
}

export interface BuiltinCapabilityPack {
  protocolVersion: 1
  id: CapabilityId
  title: string
  version: string
  featureFlag?: string
  requiresPacks: readonly CapabilityId[]
  actions: readonly BuiltinActionContribution[]
  contexts: readonly ContextProviderDescriptor[]
  skills: readonly SkillFragment[]
}

export interface ExternalToolAllowEntry {
  remoteName: string
  localId: CapabilityId
  title?: string
  description?: string
  input?: JsonSchema
  output?: JsonSchema
  inputDigest: string
  outputDigest?: string
  scope?: ActionScope
  surface?: CapabilitySurface
  headless?: 'supported' | 'requires-ui'
  effects: readonly ActionEffect[]
  policyFloor: PolicyGate
}

export interface ExternalToolManifest {
  protocolVersion: 1
  sourceId: CapabilityId
  title?: string
  version?: string
  connectorRef: CapabilityId
  mode: 'declared' | 'discover'
  featureFlag?: string
  allow: readonly ExternalToolAllowEntry[]
}

export interface DiscoveredExternalTool {
  title?: string
  description?: string
  input: JsonSchema
  output?: JsonSchema
}

export const capabilityIdSchema = z
  .string()
  .regex(CAPABILITY_ID_PATTERN, 'Capability id must use lowercase dotted segments (e.g. studio.board.read)')
  .transform((value) => value as CapabilityId)

const actionEffectSchema = z.enum(['read', 'select', 'write', 'run', 'delete', 'export', 'install', 'configure', 'interact'])
const policyGateSchema = z.enum(['auto', 'approval', 'human-only'])
const actionScopeSchema = z.enum(['session', 'project', 'application'])
const surfaceSchema = z.enum(['/studio', '/manga', '/library', '/models', '/training'])
const jsonSchemaObject = z.record(z.string(), z.unknown())

export const externalToolManifestSchema = z.strictObject({
  protocolVersion: z.literal(CAPABILITY_PROTOCOL_VERSION),
  sourceId: capabilityIdSchema,
  title: z.string().trim().min(1).max(80).optional(),
  version: z.string().trim().min(1).max(40).optional(),
  connectorRef: capabilityIdSchema,
  mode: z.enum(['declared', 'discover']),
  featureFlag: z.string().trim().min(1).max(80).optional(),
  allow: z
    .array(
      z.strictObject({
        remoteName: z.string().trim().min(1).max(120),
        localId: capabilityIdSchema,
        title: z.string().trim().min(1).max(80).optional(),
        description: z.string().trim().min(1).max(2000).optional(),
        input: jsonSchemaObject.optional(),
        output: jsonSchemaObject.optional(),
        inputDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'inputDigest must be a sha256:<hex> digest'),
        outputDigest: z
          .string()
          .regex(/^sha256:[0-9a-f]{64}$/, 'outputDigest must be a sha256:<hex> digest')
          .optional(),
        scope: actionScopeSchema.optional(),
        surface: surfaceSchema.optional(),
        headless: z.enum(['supported', 'requires-ui']).optional(),
        effects: z.array(actionEffectSchema).min(1),
        policyFloor: policyGateSchema,
      }),
    )
    .min(1)
    .max(200),
})

export function isCapabilityId(value: string): value is CapabilityId {
  return CAPABILITY_ID_PATTERN.test(value)
}

/** Convert a Zod schema into a closed JSON Schema without the `$schema` key some providers reject. */
export function toClosedJsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema) as Record<string, unknown>
  return json
}

/** Canonical JSON serialization with sorted object keys for stable schema digests. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`
}

// Pure TypeScript SHA-256 so shared/ computes digests synchronously without importing node:crypto.
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
  0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
  0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
  0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const

const SHA256_INIT = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19] as const

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

/** Synchronous UTF-8 SHA-256 returning `sha256:<64 hex chars>`. */
export function sha256Text(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const bitLen = bytes.length * 8
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64
  const buffer = new Uint8Array(paddedLen)
  buffer.set(bytes)
  buffer[bytes.length] = 0x80
  const view = new DataView(buffer.buffer)
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(paddedLen - 4, bitLen >>> 0, false)

  const hash: number[] = [...SHA256_INIT]
  const w = new Uint32Array(64)
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false)
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = hash as [number, number, number, number, number, number, number, number]
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    hash[0] = (hash[0]! + a) >>> 0
    hash[1] = (hash[1]! + b) >>> 0
    hash[2] = (hash[2]! + c) >>> 0
    hash[3] = (hash[3]! + d) >>> 0
    hash[4] = (hash[4]! + e) >>> 0
    hash[5] = (hash[5]! + f) >>> 0
    hash[6] = (hash[6]! + g) >>> 0
    hash[7] = (hash[7]! + h) >>> 0
  }
  return `sha256:${hash.map((word) => word.toString(16).padStart(8, '0')).join('')}`
}

/** Deterministic SHA-256 digest of a JSON Schema for manifest integrity checks. */
export function schemaDigest(schema: JsonSchema): string {
  return sha256Text(canonicalJson(schema))
}

const DEFAULT_OUTPUT_SCHEMA: JsonSchema = { type: 'object' }

/** Convert a built-in action contribution into its transport-safe descriptor. */
export function descriptorFromContribution(packId: CapabilityId, action: BuiltinActionContribution): ActionDescriptor {
  return {
    id: action.id,
    ...(action.legacyAlias ? { legacyAlias: action.legacyAlias } : {}),
    version: action.version ?? 1,
    packId,
    title: action.title,
    description: action.description,
    input: toClosedJsonSchema(action.inputSchema),
    output: action.outputSchema ?? DEFAULT_OUTPUT_SCHEMA,
    target: action.target,
    scope: action.scope,
    ...(action.surface ? { surface: action.surface } : {}),
    effects: [...action.effects],
    policyFloor: action.policyFloor,
    requires: [...action.requires],
    headless: action.headless,
    ...(action.summarizeLabel ? { summarizeLabel: action.summarizeLabel } : {}),
    binding: { kind: 'builtin', handlerId: action.id },
  }
}

/** Strip runtime Zod/function fields to produce a pure serializable CapabilityPack. */
export function packDescriptorFromBuiltin(pack: BuiltinCapabilityPack): CapabilityPack {
  return {
    protocolVersion: pack.protocolVersion,
    id: pack.id,
    title: pack.title,
    version: pack.version,
    ...(pack.featureFlag ? { featureFlag: pack.featureFlag } : {}),
    requiresPacks: [...pack.requiresPacks],
    actions: pack.actions.map((action) => descriptorFromContribution(pack.id, action)),
    contexts: pack.contexts.map((context) => ({ ...context })),
    skills: pack.skills.map((skill) => ({
      ...skill,
      requiresActions: [...skill.requiresActions],
      audience: [...skill.audience],
    })),
  }
}

/**
 * Turn a validated ExternalToolManifest (and optional discovered tool metadata)
 * into a CapabilityPack whose schemas match the declared digests.
 */
export function packFromExternalManifest(
  rawManifest: ExternalToolManifest,
  discovered: Readonly<Record<string, DiscoveredExternalTool>> = {},
): CapabilityPack {
  const manifest = externalToolManifestSchema.parse(rawManifest)
  const actions: ActionDescriptor[] = manifest.allow.map((entry) => {
    const remote = discovered[entry.remoteName]
    const input = manifest.mode === 'declared' ? entry.input : (remote?.input ?? entry.input)
    if (!input) {
      throw new Error(`External tool ${entry.localId} (${entry.remoteName}) is missing an input schema`)
    }
    const actualInputDigest = schemaDigest(input)
    if (actualInputDigest !== entry.inputDigest) {
      throw new Error(
        `External tool ${entry.localId} (${entry.remoteName}) input schema digest mismatch: expected ${entry.inputDigest}, got ${actualInputDigest}`,
      )
    }
    const output = entry.output ?? remote?.output ?? DEFAULT_OUTPUT_SCHEMA
    if (entry.outputDigest) {
      const actualOutputDigest = schemaDigest(output)
      if (actualOutputDigest !== entry.outputDigest) {
        throw new Error(
          `External tool ${entry.localId} (${entry.remoteName}) output schema digest mismatch: expected ${entry.outputDigest}, got ${actualOutputDigest}`,
        )
      }
    }
    const title = entry.title ?? remote?.title ?? entry.remoteName
    const description = entry.description ?? remote?.description
    if (!description) {
      throw new Error(`External tool ${entry.localId} (${entry.remoteName}) is missing a description`)
    }
    return {
      id: entry.localId,
      version: 1,
      packId: manifest.sourceId,
      title,
      description,
      input,
      output,
      target: 'main',
      scope: entry.scope ?? 'project',
      ...(entry.surface ? { surface: entry.surface } : {}),
      effects: [...entry.effects],
      policyFloor: entry.policyFloor,
      requires: [],
      headless: entry.headless ?? 'supported',
      binding: { kind: 'external', sourceId: manifest.sourceId, remoteName: entry.remoteName },
    }
  })

  return {
    protocolVersion: CAPABILITY_PROTOCOL_VERSION,
    id: manifest.sourceId,
    title: manifest.title ?? manifest.sourceId,
    version: manifest.version ?? '1.0.0',
    ...(manifest.featureFlag ? { featureFlag: manifest.featureFlag } : {}),
    requiresPacks: [],
    actions,
    contexts: [],
    skills: [],
  }
}
