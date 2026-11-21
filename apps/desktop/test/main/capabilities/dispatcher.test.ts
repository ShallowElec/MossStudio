import { existsSync, readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ALL_CAPABILITY_PACKS, createBuiltinCapabilityRegistry } from '@shared/capabilities'
import { paths } from '@main/lib/paths'
import {
  createBuiltinMainHandlers,
  createMainCapabilityDispatcher,
  flushCapabilityAudit,
  listCapabilityAudit,
  resetCapabilityAuditMemory,
} from '@main/capabilities'
import * as trainingHosts from '@main/services/trainingHosts'
import * as engines from '@main/services/engines'
import * as models from '@main/services/models'
import * as workerHosts from '@main/services/workerHostManager'
import * as remoteWorker from '@main/services/remoteWorker'
import * as loraProfiles from '@main/services/loraProfiles'
import type { ManagedHost } from '@shared/types'
import { useTempDataRoot } from '@test/helpers/tempDir'

useTempDataRoot()

/** remote.hosts.* is behind 设置 › 功能 › 远程主机 (and its Worker hosts behind their own switch). */
const REMOTE = { remoteHostsEnabled: true, workerHostsEnabled: true }

beforeEach(() => {
  resetCapabilityAuditMemory()
})

describe('main/capabilities dispatcher and audit trail', () => {
  it('lists only remote hosts using a credential-free field allowlist', async () => {
    const host = {
      id: 'ssh-worker',
      name: 'Worker',
      kind: 'ssh',
      remoteBackend: 'worker-daemon',
      status: 'ok',
      trainerRoot: '/trainer',
      identityFile: '/private/key',
      password: 'secret-password',
      token: 'secret-token',
      workerDiscoveryPath: '/private/discovery.json',
      devices: [],
    } as ManagedHost
    const spy = vi.spyOn(trainingHosts, 'listManagedHosts').mockReturnValue([{ ...host, id: 'local', kind: 'local' }, host])
    try {
      const dispatcher = createMainCapabilityDispatcher({ mainHandlers: createBuiltinMainHandlers(), readFlags: () => REMOTE })
      const result = await dispatcher.execute({ name: 'remote.hosts.list', source: 'external-agent' })
      expect(result.ok).toBe(true)
      expect(JSON.parse(result.content)).toEqual({
        hosts: [
          {
            id: 'ssh-worker',
            name: 'Worker',
            kind: 'ssh',
            remoteBackend: 'worker-daemon',
            status: 'ok',
            devices: [],
          },
        ],
      })
      expect(result.content).not.toMatch(/secret|private|identityFile|token|password/)
    } finally {
      spy.mockRestore()
    }
  })

  it('refuses remote.hosts.* while 设置 › 功能 › 远程主机 is off', async () => {
    const list = vi.fn(() => ({ hosts: [] }))
    const dispatcher = createMainCapabilityDispatcher({ mainHandlers: { 'remote.hosts.list': list }, readFlags: () => ({}) })
    const result = await dispatcher.execute({ name: 'remote.hosts.list', source: 'external-agent' })
    expect(result.ok).toBe(false)
    expect(JSON.parse(result.content).error).toContain('远程主机')
    expect(list).not.toHaveBeenCalled()
  })

  it('tests hosts, refreshes status and invalidates the catalog after connecting', async () => {
    const host: ManagedHost = { id: 'ssh-node', name: 'Node', kind: 'ssh', trainerRoot: '/trainer', status: 'unchecked', devices: [] }
    vi.spyOn(trainingHosts, 'getTrainingHost').mockReturnValue(host)
    const testHost = vi.spyOn(trainingHosts, 'testTrainingHost').mockResolvedValue({ ...host, status: 'ok' })
    vi.spyOn(trainingHosts, 'listManagedHosts').mockReturnValue([host])
    const invalidate = vi.spyOn(models, 'invalidateCatalog').mockImplementation(() => {})
    const status = vi
      .spyOn(engines, 'remoteEngineInfo')
      .mockResolvedValue({ online: true } as Awaited<ReturnType<typeof engines.remoteEngineInfo>>)
    try {
      const dispatcher = createMainCapabilityDispatcher({ mainHandlers: createBuiltinMainHandlers(), readFlags: () => REMOTE })
      const result = await dispatcher.execute({ name: 'remote.hosts.test', arguments: { hostId: host.id } })
      expect(result.ok).toBe(true)
      expect(JSON.parse(result.content)).toMatchObject({ id: host.id, status: 'ok', remoteBackend: 'moss-ssh', devices: [] })
      expect(testHost).toHaveBeenCalledWith(expect.anything(), host.id)
      expect(invalidate).toHaveBeenCalledOnce()
      expect((await dispatcher.execute({ name: 'remote.hosts.status', arguments: { hostId: host.id, refresh: true } })).ok).toBe(true)
      expect(status).toHaveBeenCalledWith(host.id, true)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('connects the requested Worker for LoRA metadata and registration, rejecting non-Worker hosts', async () => {
    const host: ManagedHost = {
      id: 'ssh-worker',
      name: 'Worker',
      kind: 'ssh',
      remoteBackend: 'worker-daemon',
      trainerRoot: '/trainer',
      status: 'ok',
      devices: [],
    }
    const getHost = vi.spyOn(trainingHosts, 'getTrainingHost').mockReturnValue(host)
    const profile = { id: 'worker-node' } as Awaited<ReturnType<typeof workerHosts.connectWorkerHost>>
    const connect = vi.spyOn(workerHosts, 'connectWorkerHost').mockResolvedValue(profile)
    const item = { id: 'style.safetensors', name: 'style', sizeBytes: 12, registered: false }
    const list = vi.spyOn(remoteWorker, 'listRemoteWorkerLoras').mockResolvedValue({ items: [item] })
    vi.spyOn(loraProfiles, 'mergeLoraMeta').mockResolvedValue({ ...item, triggers: ['style-token'] })
    const change = vi.spyOn(remoteWorker, 'changeRemoteWorkerLora').mockResolvedValue({ id: item.id, registered: false })
    const invalidate = vi.spyOn(models, 'invalidateCatalog').mockImplementation(() => {})
    try {
      const dispatcher = createMainCapabilityDispatcher({ mainHandlers: createBuiltinMainHandlers(), readFlags: () => REMOTE })
      dispatcher.requestApproval = async () => true
      const result = await dispatcher.execute({ name: 'remote.hosts.loras_list', arguments: { hostId: host.id, candidates: true } })
      expect(result.ok).toBe(true)
      expect(JSON.parse(result.content)).toEqual({ value: [{ ...item, triggers: ['style-token'] }] })
      expect(connect).toHaveBeenCalledWith(host)
      expect(list).toHaveBeenCalledWith(profile, true)
      const registered = await dispatcher.execute({
        name: 'remote.hosts.lora_register',
        arguments: { hostId: host.id, id: item.id, action: 'unregister' },
      })
      expect(registered.ok).toBe(true)
      expect(change).toHaveBeenCalledWith(profile, item.id, 'unregister')
      expect(invalidate).toHaveBeenCalledOnce()
      getHost.mockReturnValue({ ...host, remoteBackend: 'moss-ssh' })
      expect((await dispatcher.execute({ name: 'remote.hosts.loras_list', arguments: { hostId: host.id } })).ok).toBe(false)
      expect(connect).toHaveBeenCalledTimes(2)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('requires human approval before changing remote Worker LoRA registration, and a caller cannot claim one', async () => {
    const change = vi.fn(() => ({ registered: true }))
    const dispatcher = createMainCapabilityDispatcher({ mainHandlers: { 'remote.hosts.lora_register': change }, readFlags: () => REMOTE })
    const call = {
      name: 'remote.hosts.lora_register',
      arguments: { hostId: 'ssh-worker', id: 'style', action: 'register', approved: true },
      source: 'external-agent' as const,
    }
    const blocked = await dispatcher.execute({ ...call, arguments: { hostId: 'ssh-worker', id: 'style', action: 'register' } })
    expect(blocked.ok).toBe(false)
    expect(JSON.parse(blocked.content).requiresApproval).toBe(true)
    expect((await dispatcher.execute(call)).ok).toBe(false)
    expect(change).not.toHaveBeenCalled()
    dispatcher.requestApproval = async () => false
    expect((await dispatcher.execute({ ...call, arguments: { hostId: 'ssh-worker', id: 'style', action: 'register' } })).ok).toBe(false)
    dispatcher.requestApproval = async () => true
    expect((await dispatcher.execute({ ...call, arguments: { hostId: 'ssh-worker', id: 'style', action: 'register' } })).ok).toBe(true)
    expect(change).toHaveBeenCalledOnce()
  })

  it('binds a main-process handler for every target=main action across all 15 built-in packs', () => {
    const registry = createBuiltinCapabilityRegistry()
    const handlers = createBuiltinMainHandlers()
    const mainActions = registry
      .listActions({ enabledFlags: { gbcEnabled: true, trainingEnabled: true } })
      .filter((action) => action.target === 'main')

    expect(ALL_CAPABILITY_PACKS.length).toBe(15)
    expect(mainActions.length).toBeGreaterThanOrEqual(50)
    for (const action of mainActions) {
      expect(typeof handlers[action.id], `missing main handler for ${action.id}`).toBe('function')
    }
  })

  it('executes main-targeted actions headlessly, enforces feature flags and policy floors, and persists JSONL audit records', async () => {
    let flags: Record<string, boolean> = { gbcEnabled: false, trainingEnabled: false }
    const deleted: string[] = []
    const rendererCalls: Array<{ name: string; conversationId?: string }> = []

    const dispatcher = createMainCapabilityDispatcher({
      registry: createBuiltinCapabilityRegistry(),
      readFlags: () => flags,
      mainHandlers: {
        'studio.projects.list': () => ({ projects: [{ id: 'proj-1', name: '海报' }] }),
        'studio.projects.delete': ({ id }) => {
          deleted.push(String(id))
          return { deleted: id }
        },
        'studio.gbc.status': () => ({ ready: true }),
      },
      runInRenderer: async (call, _mode, conversationId) => {
        rendererCalls.push({ name: call.name, conversationId })
        return { ok: true, content: JSON.stringify({ selected: 'c1' }) }
      },
    })

    // 1. Read action succeeds headlessly.
    const listed = await dispatcher.execute({
      name: 'studio.projects.list',
      source: 'external-agent',
      conversationId: 'conv-1',
    })
    expect(listed.ok).toBe(true)
    expect(JSON.parse(listed.content)).toEqual({ projects: [{ id: 'proj-1', name: '海报' }] })

    // 2. Disabled feature flag pack is refused and audited.
    const gbcBlocked = await dispatcher.execute({
      name: 'studio.gbc.status',
      source: 'external-agent',
      conversationId: 'conv-1',
    })
    expect(gbcBlocked.ok).toBe(false)
    expect(gbcBlocked.content).toContain('未开启')

    flags = { gbcEnabled: true, trainingEnabled: false }
    const gbcAllowed = await dispatcher.execute({
      name: 'studio.gbc.status',
      source: 'external-agent',
      conversationId: 'conv-1',
    })
    expect(gbcAllowed.ok).toBe(true)

    // 3. Approval-gated destructive action is blocked without approval, deferred in advanced mode, and runs when approved.
    const unapproved = await dispatcher.execute({
      name: 'studio.projects.delete',
      arguments: { id: 'proj-1' },
      source: 'external-agent',
      conversationId: 'conv-1',
    })
    expect(unapproved.ok).toBe(false)
    expect(JSON.parse(unapproved.content).requiresApproval).toBe(true)
    expect(deleted).toEqual([])

    const deferred = await dispatcher.execute({
      name: 'studio.projects.delete',
      arguments: { id: 'proj-1' },
      mode: 'advanced',
      source: 'assistant',
      conversationId: 'conv-2',
    })
    expect(deferred.ok).toBe(true)
    expect(JSON.parse(deferred.content).proposed).toMatchObject({ tool: 'studio.projects.delete', args: { id: 'proj-1' } })
    expect(deleted).toEqual([])

    dispatcher.requestApproval = async () => true
    const approved = await dispatcher.execute({
      name: 'studio.projects.delete',
      arguments: { id: 'proj-1' },
      source: 'external-agent',
      conversationId: 'conv-1',
    })
    expect(approved.ok).toBe(true)
    expect(deleted).toEqual(['proj-1'])

    // 4. Renderer-targeted legacy alias delegates with conversationId and is audited.
    const relayed = await dispatcher.execute({
      name: 'studio_read_context',
      source: 'assistant',
      conversationId: 'conv-2',
    })
    expect(relayed.ok).toBe(true)
    expect(rendererCalls).toEqual([{ name: 'studio_read_context', conversationId: 'conv-2' }])

    // 5. Audit trail (操作留痕) is persisted on disk and reloads after memory reset.
    await flushCapabilityAudit()
    expect(existsSync(paths.capabilityAudit())).toBe(true)
    const lines = readFileSync(paths.capabilityAudit(), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(7)

    resetCapabilityAuditMemory()
    const reloaded = await listCapabilityAudit({ conversationId: 'conv-2' })
    expect(reloaded).toHaveLength(2)
    expect(reloaded[0]!.actionId).toBe('studio.board.read_context')
    expect(reloaded[1]!.actionId).toBe('studio.projects.delete')
  })

  it('rejects malformed arguments before invoking handlers and records the failure in audit', async () => {
    const spy = vi.fn()
    const dispatcher = createMainCapabilityDispatcher({
      registry: createBuiltinCapabilityRegistry(),
      mainHandlers: { 'studio.projects.get': spy },
    })

    const bad = await dispatcher.execute({
      name: 'studio.projects.get',
      arguments: { id: '../escape' },
      source: 'ipc',
    })
    expect(bad.ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()

    const entries = await listCapabilityAudit({ actionId: 'studio.projects.get' })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.ok).toBe(false)
    expect(entries[0]!.error).toBeTruthy()
  })
})
