import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ALL_CAPABILITY_PACKS, createCapabilityRegistry, type BuiltinCapabilityPack } from '@shared/capabilities'
import type { ManagedHost, ProjectCanvas, Settings } from '@shared/types'
import { runExternalToolCall, legacyToolName, registerStudioTools, type StudioToolApi } from '@renderer/lib/agentTools'
import { createRendererCapabilityHost } from '@renderer/lib/capabilities'
import { LOCAL_HOST_ID, registerStudioCapabilities, type StudioCapabilityDeps } from '@renderer/pages/studio/studioCapabilities'
import { externalFocusMessage, externalFocusOf } from '@renderer/pages/studio/useStudioProject'
import { canvas } from './fixtures'

afterEach(() => registerStudioTools(null))

function deps(
  canvases: ProjectCanvas[],
  selected: string | null,
): StudioCapabilityDeps & { state: { canvases: ProjectCanvas[]; selected: string | null } } {
  const state = { canvases, selected }
  const project = {
    projectId: 'p1',
    projectName: '海报',
    canvasesRef: {
      get current() {
        return state.canvases
      },
    },
    selectedRef: {
      get current() {
        return state.selected
      },
    },
    setCanvases: (next: ProjectCanvas[] | ((previous: ProjectCanvas[]) => ProjectCanvas[])) => {
      state.canvases = typeof next === 'function' ? next(state.canvases) : next
    },
    updateCanvas: (id: string, patch: Partial<ProjectCanvas> | ((item: ProjectCanvas) => ProjectCanvas)) => {
      state.canvases = state.canvases.map((item) =>
        item.id === id ? (typeof patch === 'function' ? patch(item) : { ...item, ...patch }) : item,
      )
    },
    select: (id: string | null) => {
      state.selected = id
    },
    removeCanvas: (id: string) => {
      state.canvases = state.canvases.filter((item) => item.id !== id)
      return 0
    },
  }
  return {
    state,
    project,
    cancelJob: vi.fn(async () => undefined),
    catalog: null,
    preferredBundleId: null,
    engineReadiness: null,
    settings: null,
    update: null,
    remoteHost: null,
    boardFeatures: null,
    controlAdapters: [],
    controlAdaptersLoaded: true,
    gpuInventory: null,
    jobs: [],
    problems: () => [],
  }
}

const call = (name: string, args: Record<string, unknown> = {}, extra: { turnId?: string; mode?: 'auto' | 'advanced' } = {}) => ({
  callId: `c-${name}`,
  name,
  arguments: JSON.stringify(args),
  ...extra,
})

describe('Studio capabilities for external Agents', () => {
  it('runs a capability that has no built-in tool, with its own checks, and unregisters on dispose', async () => {
    const host = createRendererCapabilityHost()
    const live = deps([canvas({ id: 'a', title: '画面 1' })], 'a')
    const dispose = registerStudioCapabilities(() => live, host)
    expect(host.hasHandler('studio.cards.create')).toBe(true)
    expect(host.hasHandler('studio.board.diagnose')).toBe(true)
    // Built-in tools keep their own path.
    expect(host.hasHandler('studio.sampling.set')).toBe(false)

    const created = await host.execute({
      id: '1',
      name: 'studio.cards.create',
      arguments: JSON.stringify({ title: '港口', prompt: '灯塔' }),
    })
    expect(created.ok).toBe(true)
    const body = JSON.parse(created.content) as { id: string; summary: string; problems: string[] }
    expect(live.state.canvases.at(-1)).toMatchObject({ id: body.id, title: '港口' })
    expect(live.state.selected).toBe(body.id)
    expect(body.problems).toEqual([])

    const wrong = await host.execute({ id: '2', name: 'studio.cards.duplicate', arguments: JSON.stringify({ canvasId: 'nope' }) })
    expect(JSON.parse(wrong.content)).toEqual({ error: '没有这个画面：nope' })

    const advanced = await host.execute({ id: '3', name: 'studio.cards.tidy', arguments: '{}' }, { mode: 'advanced' })
    expect(JSON.parse(advanced.content)).toHaveProperty('proposed.tool', 'studio.cards.tidy')

    dispose()
    expect(host.hasHandler('studio.cards.create')).toBe(false)
    expect(JSON.parse((await host.execute({ id: '4', name: 'studio.cards.create', arguments: '{}' })).content).error).toContain(
      'Studio 尚未就绪',
    )
  })

  it('sends a capability that supersedes a built-in tool down the built-in path', () => {
    expect(legacyToolName('studio_set_sampler')).toBe('studio_set_sampler')
    expect(legacyToolName('studio.sampling.set')).toBe('studio_set_sampler')
    expect(legacyToolName('studio.cards.create')).toBeNull()
  })

  it('groups and follows every external Agent call, also one that names a built-in tool', async () => {
    const setSampler = vi.fn(() => ({ steps: 20 }))
    const follow = vi.fn(<T>(_call: string, run: () => Promise<T>) => run())
    registerStudioTools({
      state: () => ({ hasSelection: true, editable: true }),
      setSampler,
      problems: () => [],
      followExternal: follow,
    } as unknown as StudioToolApi)
    const host = createRendererCapabilityHost()

    const external = await runExternalToolCall({ ...call('studio.sampling.set', { steps: 37 }), external: true }, host)
    expect(external.ok).toBe(true)
    expect(setSampler).toHaveBeenCalledWith({ steps: 37 })
    expect(follow).toHaveBeenCalledTimes(1)
    expect(follow.mock.calls[0]![0]).toBe('c-studio.sampling.set')
  })
})

describe('externalFocusOf', () => {
  const a = canvas({ id: 'a', title: '画面 1', prompt: '海' })
  const b = canvas({ id: 'b', title: '画面 2' })

  it('follows a card an external Agent added', () => {
    const focus = externalFocusOf({ canvases: [a], selectedId: 'a' }, { canvases: [a, b], selectedId: 'a' })
    expect(focus).toEqual({ canvasId: 'b', title: '画面 2', change: 'added' })
    expect(externalFocusMessage(focus!)).toBe('外部 Agent 新建了「画面 2」')
  })

  it('follows a new selection, and says when the open card was rewritten', () => {
    expect(externalFocusOf({ canvases: [a, b], selectedId: 'a' }, { canvases: [a, b], selectedId: 'b' })?.change).toBe('selected')
    const edited = { ...a, prompt: '山' }
    expect(externalFocusOf({ canvases: [a], selectedId: 'a' }, { canvases: [edited], selectedId: 'a' })).toEqual({
      canvasId: 'a',
      title: '画面 1',
      change: 'edited',
    })
    const regions = {
      ...a,
      layers: [
        {
          ...a.layers[0],
          id: 'r',
          kind: 'object' as const,
          caption: 'x',
          bbox: [0, 0, 1, 1] as [number, number, number, number],
          visible: true,
          locked: false,
          opacity: 1,
        },
      ],
    }
    expect(externalFocusOf({ canvases: [a], selectedId: 'a' }, { canvases: [regions], selectedId: 'a' })?.change).toBe('edited')
  })

  it('stays quiet when nothing the person would miss happened', () => {
    expect(externalFocusOf({ canvases: [a, b], selectedId: 'a' }, { canvases: [a, { ...b, prompt: 'x' }], selectedId: 'a' })).toBeNull()
  })

  it('does not call the cards of a project the call opened or created new', () => {
    expect(externalFocusOf({ canvases: [a], selectedId: 'a', session: 1 }, { canvases: [b], selectedId: 'b', session: 2 })).toBeNull()
    expect(externalFocusOf({ canvases: [a], selectedId: 'a', session: 1 }, { canvases: [a, b], selectedId: 'a', session: 1 })?.change).toBe(
      'added',
    )
  })
})

describe('remote.hosts.select', () => {
  const remotePack: BuiltinCapabilityPack = {
    protocolVersion: 1,
    id: 'remote.hosts',
    title: '远程主机',
    version: '1.0.0',
    requiresPacks: [],
    actions: [
      {
        id: 'remote.hosts.select',
        title: '切换运行位置',
        description: 'Switch where Studio runs generation.',
        inputSchema: z.strictObject({ hostId: z.string().trim().min(1).max(120) }),
        target: 'renderer',
        scope: 'application',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => `运行位置：${String(args.hostId)}`,
      },
    ],
    contexts: [],
    skills: [],
  }
  const withoutRemote = ALL_CAPABILITY_PACKS.filter((pack) => pack.id !== 'remote.hosts')
  const sshHost = { id: 'gpu-box', name: '显卡机', kind: 'ssh' } as unknown as ManagedHost

  function setup(remoteHostsEnabled = true) {
    const host = createRendererCapabilityHost(createCapabilityRegistry([...withoutRemote, remotePack]))
    const live = deps([canvas({ id: 'a' })], 'a')
    const selected: string[] = []
    live.settings = { remoteHostsEnabled } as unknown as Settings
    live.remoteHosts = [sshHost]
    live.selectRemoteHost = (id) => selected.push(id)
    const dispose = registerStudioCapabilities(() => live, host)
    const run = async (args: Record<string, unknown>) => {
      const result = await host.execute({ id: 'r', name: 'remote.hosts.select', arguments: JSON.stringify(args) })
      return { ok: result.ok, body: JSON.parse(result.content) as Record<string, unknown> }
    }
    return { host, live, selected, dispose, run }
  }

  it('switches to a configured host or back to this computer', async () => {
    const { selected, run, host, dispose } = setup()
    expect(await run({ hostId: 'gpu-box' })).toMatchObject({ ok: true, body: { ok: true, hostId: 'gpu-box' } })
    expect(await run({ hostId: LOCAL_HOST_ID })).toMatchObject({ ok: true, body: { ok: true, hostId: 'local' } })
    expect(selected).toEqual(['gpu-box', 'local'])
    dispose()
    expect(host.hasHandler('remote.hosts.select')).toBe(false)
  })

  it('refuses an unknown host, or any remote host while the feature is off, without switching', async () => {
    const on = setup()
    expect(await on.run({ hostId: 'nope' })).toEqual({ ok: false, body: { error: '没有这个远程主机：nope' } })
    expect((await on.run({})).ok).toBe(false)
    expect(on.selected).toEqual([])
    const off = setup(false)
    expect((await off.run({ hostId: 'gpu-box' })).body.error).toContain('远程主机功能还没打开')
    expect((await off.run({ hostId: 'local' })).ok).toBe(true)
    expect(off.selected).toEqual(['local'])
  })

  it('registers nothing for remote hosts when the registry has no such pack', () => {
    const host = createRendererCapabilityHost(createCapabilityRegistry(withoutRemote))
    const dispose = registerStudioCapabilities(() => deps([], null), host)
    expect(host.hasHandler('studio.cards.create')).toBe(true)
    expect(host.hasHandler('remote.hosts.select')).toBe(false)
    dispose()
  })
})

describe('studio.projects.import_image', () => {
  it('puts the imported card into the external call step even though it lands after the import awaited', async () => {
    const host = createRendererCapabilityHost()
    const live = deps([canvas({ id: 'a', title: '画面 1' })], 'a')
    const groups: string[] = []
    let open: string | null = null
    const placed: Array<string | null> = []
    live.project = {
      ...live.project,
      setCanvases: (next) => {
        placed.push(open)
        live.state.canvases = typeof next === 'function' ? next(live.state.canvases) : next
      },
      history: {
        within: <T>(group: { key: string }, run: () => T): T => {
          groups.push(group.key)
          open = group.key
          try {
            return run()
          } finally {
            open = null
          }
        },
      } as unknown as NonNullable<StudioCapabilityDeps['project']['history']>,
    }
    live.importImageFile = async () => {
      await Promise.resolve()
      return { path: 'p1/inputs/x.png', width: 512, height: 512 }
    }
    registerStudioCapabilities(() => live, host)
    const result = await host.execute({
      id: 'call-9',
      name: 'studio.projects.import_image',
      arguments: JSON.stringify({ path: 'C:/x.png' }),
    })
    expect(result.ok).toBe(true)
    expect(groups).toEqual(['external:call-9'])
    expect(placed).toEqual(['external:call-9'])
    expect(live.state.selected).toBe(live.state.canvases.at(-1)!.id)
  })
})
