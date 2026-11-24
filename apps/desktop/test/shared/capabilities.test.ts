import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ALL_CAPABILITY_PACKS,
  APP_ACTION_SCHEMAS,
  BUILTIN_CAPABILITY_REGISTRY,
  CAPABILITY_PROTOCOL_VERSION,
  MOSS_LAYOUT_DESIGN_SKILL_MD,
  MOSS_PROMPTCRAFT_SKILL_MD,
  STUDIO_ACTION_SCHEMAS,
  STUDIO_CAPABILITY_PACKS,
  composeOfficialGuide,
  createBuiltinCapabilityRegistry,
  createCapabilityRegistry,
  createStudioCapabilityRegistry,
  projectCapabilities,
  schemaDigest,
  sha256Text,
  type BuiltinCapabilityPack,
  type ExternalToolManifest,
} from '@shared/capabilities'
import { AGENT_TOOL_NAMES } from '@shared/agent/registry'

interface JsonSchemaNode {
  type?: string
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean
}

function walkSchema(node: JsonSchemaNode, visit: (current: JsonSchemaNode, path: string) => void, path = '$'): void {
  visit(node, path)
  for (const [key, child] of Object.entries(node.properties ?? {})) walkSchema(child, visit, `${path}.${key}`)
}

describe('shared/capabilities protocol and registry', () => {
  it('exposes six closed remote host actions in the compact profile with registration approval', () => {
    const projected = projectCapabilities(BUILTIN_CAPABILITY_REGISTRY, { profile: 'compact', enabledFlags: { remoteHostsEnabled: true } })
    expect(projectCapabilities(BUILTIN_CAPABILITY_REGISTRY, { profile: 'compact' }).actions.some((a) => a.packId === 'remote.hosts')).toBe(
      false,
    )
    const actions = projected.actions.filter((action) => action.packId === 'remote.hosts')
    expect(actions).toHaveLength(6)
    for (const action of actions) expect(action.input.additionalProperties).toBe(false)
    expect(actions.find((action) => action.id === 'remote.hosts.lora_register')).toMatchObject({
      target: 'main',
      effects: ['write'],
      policyFloor: 'approval',
    })
    // Switching where every later run goes is the person's call (S4).
    expect(actions.find((action) => action.id === 'remote.hosts.select')).toMatchObject({
      target: 'renderer',
      effects: ['write'],
      policyFloor: 'approval',
    })
    expect(projected.skill.markdown).toContain('remote.hosts.test')
  })

  it('computes standard SHA-256 digests deterministically in pure TypeScript', () => {
    expect(sha256Text('')).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Text('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(schemaDigest({ type: 'object', additionalProperties: false })).toBe(
      schemaDigest({ additionalProperties: false, type: 'object' }),
    )
  })

  it('registers all 18 MossStudio packs with closed top-level JSON Schemas and zero duplicate ids or aliases', () => {
    const allFlags = { gbcEnabled: true, trainingEnabled: true, remoteHostsEnabled: true, externalImageEditEnabled: true }
    const actions = BUILTIN_CAPABILITY_REGISTRY.listActions({ enabledFlags: allFlags })
    expect(STUDIO_CAPABILITY_PACKS.length).toBe(7)
    expect(ALL_CAPABILITY_PACKS.length).toBe(18)
    expect(actions.length).toBe(Object.keys(STUDIO_ACTION_SCHEMAS).length + Object.keys(APP_ACTION_SCHEMAS).length)

    for (const action of actions) {
      expect(action.input.$schema, action.id).toBeUndefined()
      const root = action.input as JsonSchemaNode
      expect(root.type, action.id).toBe('object')
      expect(root.additionalProperties, action.id).toBe(false)
      walkSchema(root, (node, path) => {
        if (node.type !== 'object') return
        for (const key of node.required ?? []) {
          expect(Object.keys(node.properties ?? {}), `${action.id} ${path}`).toContain(key)
        }
      })
    }

    for (const legacyName of AGENT_TOOL_NAMES) {
      const resolved = BUILTIN_CAPABILITY_REGISTRY.getAction(legacyName)
      expect(resolved, legacyName).toBeDefined()
      expect(BUILTIN_CAPABILITY_REGISTRY.getAction(resolved!.descriptor.id)?.descriptor.legacyAlias).toBe(legacyName)
    }
  })

  it('gates optional packs (GBC and Training) behind feature flags and projects Tool Profiles cleanly', () => {
    const registry = createBuiltinCapabilityRegistry()

    // Flags off: GBC and Training stay hidden.
    const defaultActions = registry.listActions()
    expect(defaultActions.some((item) => item.packId === 'studio.gbc.parse')).toBe(false)
    expect(defaultActions.some((item) => item.packId === 'training.jobs')).toBe(false)
    expect(defaultActions.some((item) => item.packId === 'library.assets')).toBe(true)
    expect(defaultActions.some((item) => item.packId === 'models.catalog')).toBe(true)
    expect(defaultActions.some((item) => item.packId === 'manga.series')).toBe(true)
    expect(defaultActions.some((item) => item.packId === 'system.runtime')).toBe(true)

    // Flags on: GBC and Training actions + skills appear automatically.
    const full = projectCapabilities(registry, {
      profile: 'atomic',
      enabledFlags: { gbcEnabled: true, trainingEnabled: true },
    })
    expect(full.actions.some((item) => item.id === 'studio.gbc.start_job')).toBe(true)
    expect(full.actions.some((item) => item.id === 'training.runs.start')).toBe(true)
    expect(full.skill.fragmentIds).toContain('studio.skill.gbc')
    expect(full.skill.fragmentIds).toContain('training.skill.jobs')

    // proposal-only profile strips every mutating/run/delete/install/configure action.
    const proposalOnly = projectCapabilities(registry, {
      profile: 'proposal-only',
      enabledFlags: { gbcEnabled: true, trainingEnabled: true },
    })
    expect(
      proposalOnly.actions.every(
        (item) => !item.effects.some((effect) => ['write', 'run', 'delete', 'export', 'install', 'configure'].includes(effect)),
      ),
    ).toBe(true)
    expect(proposalOnly.actions.some((item) => item.id === 'studio.board.diagnose')).toBe(true)
    expect(proposalOnly.actions.some((item) => item.id === 'library.assets.read_image')).toBe(true)
    expect(proposalOnly.actions.some((item) => item.id === 'studio.cards.delete')).toBe(false)
    expect(proposalOnly.actions.some((item) => item.id === 'models.catalog.delete')).toBe(false)

    // Pack dependency enforcement: disabling studio.board.read drops dependent Studio board packs.
    const onlyCards = registry.listActions({ enabledPacks: ['studio.board.cards'] })
    expect(onlyCards).toEqual([])
  })

  it('registers dynamically added packs and external manifests with SHA-256 digest checks', () => {
    const registry = createStudioCapabilityRegistry()
    const customPack: BuiltinCapabilityPack = {
      protocolVersion: CAPABILITY_PROTOCOL_VERSION,
      id: 'plugin.demo.tools',
      title: '示例扩展',
      version: '1.0.0',
      requiresPacks: ['studio.board.read'],
      actions: [
        {
          id: 'plugin.demo.ping',
          title: '探测扩展',
          description: 'Ping an optional capability pack.',
          inputSchema: z.strictObject({}),
          target: 'main',
          scope: 'application',
          effects: ['read'],
          policyFloor: 'auto',
          requires: [],
          headless: 'supported',
          summarize: () => '探测扩展',
        },
      ],
      contexts: [],
      skills: [],
    }
    registry.registerBuiltinPack(customPack)
    expect(registry.getAction('plugin.demo.ping')).toBeDefined()

    const inputSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: { query: { type: 'string', minLength: 1 } },
    }
    const manifest: ExternalToolManifest = {
      protocolVersion: 1,
      sourceId: 'ext.catalog.lookup',
      title: '外部素材检索',
      connectorRef: 'connector.mcp.assets',
      mode: 'declared',
      allow: [
        {
          remoteName: 'search_assets',
          localId: 'ext.catalog.search',
          title: '检索素材',
          description: 'Search external reference assets by keyword.',
          input: inputSchema,
          inputDigest: schemaDigest(inputSchema),
          effects: ['read'],
          policyFloor: 'auto',
        },
      ],
    }

    const pack = registry.registerExternalManifest(manifest)
    expect(pack.actions).toHaveLength(1)
    expect(pack.actions[0]!.binding).toEqual({
      kind: 'external',
      sourceId: 'ext.catalog.lookup',
      remoteName: 'search_assets',
    })
    expect(registry.validateInput('ext.catalog.search', { query: 'cherry' })).toEqual({ ok: true, data: { query: 'cherry' } })
    expect(registry.validateInput('ext.catalog.search', { query: 'cherry', extra: 1 }).ok).toBe(false)
    expect(registry.listActions({ includeExternal: false }).some((item) => item.id === 'ext.catalog.search')).toBe(false)

    expect(() =>
      registry.registerExternalManifest({
        ...manifest,
        sourceId: 'ext.catalog.tampered',
        allow: [{ ...manifest.allow[0]!, localId: 'ext.catalog.tampered_search', inputDigest: `sha256:${'0'.repeat(64)}` }],
      }),
    ).toThrow(/digest mismatch/)

    expect(() =>
      registry.registerExternalManifest({
        ...manifest,
        sourceId: 'ext.catalog.collide',
        allow: [{ ...manifest.allow[0]!, localId: 'studio.board.read_context' }],
      }),
    ).toThrow(/Duplicate capability action id/)
    expect(registry.getPack('ext.catalog.collide')).toBeUndefined()

    expect(registry.unregisterPack('ext.catalog.lookup')).toBe(true)
    expect(registry.getAction('ext.catalog.search')).toBeUndefined()
  })

  it('synthesizes deterministic skill markdown ordered by fragment order and filtered by active actions', () => {
    const registry = createCapabilityRegistry(STUDIO_CAPABILITY_PACKS)
    const readOnlySkill = registry.synthesizeSkill({ enabledPacks: ['studio.board.read'] })
    expect(readOnlySkill.fragmentIds).toEqual(['studio.skill.read'])
    expect(readOnlySkill.markdown).toContain('studio_read_context')
    expect(readOnlySkill.markdown).not.toContain('studio_generate')

    const fullSkill = registry.synthesizeSkill({ surface: '/studio' })
    expect(fullSkill.fragmentIds).toEqual([
      'studio.skill.read',
      'studio.skill.cards',
      'studio.skill.regions',
      'studio.skill.sampling',
      'studio.skill.wires',
      'studio.skill.runs',
      'studio.skill.ask',
    ])
    expect(fullSkill.digest).toMatch(/^sha256:[0-9a-f]{64}$/)

    const builtin = createBuiltinCapabilityRegistry()
    const standardProjected = projectCapabilities(builtin, { profile: 'moss-standard' })
    expect(standardProjected.actions.some((a) => a.packId === 'studio.board.regions')).toBe(false)
    expect(standardProjected.skill.fragmentIds).toContain('skill.moss.standard.guide')
    expect(standardProjected.skill.fragmentIds).not.toContain('skill.moss.layout.guide')
    expect(standardProjected.skill.markdown).toContain('Ordering (Macro -> Micro)')

    const layoutProjected = projectCapabilities(builtin, { profile: 'moss-layout' })
    expect(layoutProjected.actions.some((a) => a.packId === 'studio.board.regions')).toBe(true)
    expect(layoutProjected.skill.fragmentIds).toContain('skill.moss.standard.guide')
    expect(layoutProjected.skill.fragmentIds).toContain('skill.moss.layout.guide')
    expect(layoutProjected.skill.markdown).toContain('MOSS Layout Design Skill')
  })

  it('keeps the two guide packs out of every Skill until the person picks them', () => {
    const guidePacks = new Set(['skill.moss.standard', 'skill.moss.layout'])
    const withGuides = createBuiltinCapabilityRegistry()
    const withoutGuides = createCapabilityRegistry(ALL_CAPABILITY_PACKS.filter((pack) => !guidePacks.has(pack.id)))
    const enabledFlags = { gbcEnabled: true, trainingEnabled: true, remoteHostsEnabled: true }
    for (const profile of ['compact', 'atomic', 'proposal-only'] as const) {
      const projected = projectCapabilities(withGuides, { profile, enabledFlags })
      expect(projected.skill.markdown, profile).toBe(projectCapabilities(withoutGuides, { profile, enabledFlags }).skill.markdown)
      for (const topic of ['tools', 'all'] as const) {
        expect(composeOfficialGuide(projected.skill.markdown, topic), `${profile} ${topic}`).toBe(
          composeOfficialGuide(projectCapabilities(withoutGuides, { profile, enabledFlags }).skill.markdown, topic),
        )
      }
    }

    const picked = projectCapabilities(withGuides, { profile: 'custom', enabledPacks: ['studio.board.read', 'skill.moss.layout'] })
    expect(picked.skill.fragmentIds).toContain('skill.moss.layout.guide')
    expect(picked.skill.fragmentIds).not.toContain('skill.moss.standard.guide')
  })

  it('names only arguments the actions really take where a guide spells out a call', () => {
    const checked: string[] = []
    for (const guide of [MOSS_PROMPTCRAFT_SKILL_MD, MOSS_LAYOUT_DESIGN_SKILL_MD]) {
      // An Agent must read plain Markdown code spans, not the escapes of the source.
      expect(guide).not.toContain('\\`')
      // A call is written as `action.id` (`arg`, `arg: value`, …).
      for (const [, actionId, args] of guide.matchAll(/`((?:studio|models|remote|system)\.[\w.]+)` \(([^)]*)\)/g)) {
        const action = BUILTIN_CAPABILITY_REGISTRY.getAction(actionId!)
        expect(action, actionId).toBeDefined()
        const properties = Object.keys((action!.descriptor.input as JsonSchemaNode).properties ?? {})
        for (const [, token] of args!.matchAll(/`([A-Za-z_][\w.]*)/g)) {
          if (BUILTIN_CAPABILITY_REGISTRY.getAction(token!)) continue
          expect(properties, `${actionId} ${token}`).toContain(token)
          checked.push(`${actionId} ${token}`)
        }
      }
    }
    expect(checked).toEqual(
      expect.arrayContaining(['studio.regions.add bbox', 'studio.regions.add_text bbox', 'studio.regions.add_text text']),
    )
  })

  it('puts each creative guide into the full guide once, whether or not its pack is on', () => {
    const count = (text: string, needle: string): number => text.split(needle).length - 1
    const registry = createBuiltinCapabilityRegistry()
    for (const profile of ['compact', 'moss-standard', 'moss-layout'] as const) {
      const tools = projectCapabilities(registry, { profile }).skill.markdown
      const all = composeOfficialGuide(tools, 'all')
      expect(all.startsWith(tools), profile).toBe(true)
      expect(count(all, MOSS_PROMPTCRAFT_SKILL_MD), profile).toBe(1)
      expect(count(all, MOSS_LAYOUT_DESIGN_SKILL_MD), profile).toBe(1)
      expect(composeOfficialGuide(tools, 'tools')).toBe(tools)
    }
  })
})
