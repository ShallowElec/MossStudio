import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_CAPABILITY_REGISTRY, createBuiltinCapabilityRegistry, isMutatingEffects } from '@shared/capabilities'
import { paths } from '@main/lib/paths'
import { MAX_AUDIT_FILE_BYTES } from '@main/capabilities/audit'
import {
  createBuiltinMainHandlers,
  createMainCapabilityDispatcher,
  flushCapabilityAudit,
  listCapabilityAudit,
  recordCapabilityAudit,
  resetCapabilityAuditMemory,
} from '@main/capabilities'
import { agentPicturePath, prepareAgentPaths } from '@main/capabilities/agentPaths'
import { MAX_PENDING_PER_SOURCE, createCapabilityApprovalQueue } from '@main/agentHub/approvalQueue'
import * as supervisor from '@main/services/supervisor'
import * as trainingRun from '@main/services/training/run'
import { updateSettings } from '@main/services/settings'
import { createBuiltinMainDispatcher } from '@main/capabilities'
import { useTempDataRoot, useTempDir } from '@test/helpers/tempDir'

const root = useTempDataRoot()
const outside = useTempDir('mossstudio-outside-')

beforeEach(() => resetCapabilityAuditMemory())

const dispatcherWith = (handlers: Record<string, (args: Record<string, unknown>) => unknown>, flags: Record<string, boolean> = {}) =>
  createMainCapabilityDispatcher({ registry: createBuiltinCapabilityRegistry(), mainHandlers: handlers, readFlags: () => flags })

describe('capability dispatcher: who may run what', () => {
  it('refuses an action outside the caller’s toolset, even a registered one, and audits it', async () => {
    const remove = vi.fn(() => ({}))
    const dispatcher = dispatcherWith({ 'studio.projects.delete': remove, 'studio.projects.list': () => ({ projects: [] }) })
    dispatcher.requestApproval = async () => true
    const allowed = new Set(['studio.projects.list'])
    const refused = await dispatcher.execute({ name: 'studio.projects.delete', arguments: { id: 'p' }, source: 'external-agent', allowed })
    expect(refused.ok).toBe(false)
    expect(JSON.parse(refused.content).error).toContain('不在当前开放的工具里')
    expect(remove).not.toHaveBeenCalled()
    expect((await dispatcher.execute({ name: 'studio.projects.list', source: 'external-agent', allowed })).ok).toBe(true)
    expect((await listCapabilityAudit()).map((entry) => [entry.actionId, entry.ok])).toEqual([
      ['studio.projects.list', true],
      ['studio.projects.delete', false],
    ])
  })

  it('audits a call to a tool that does not exist', async () => {
    const result = await dispatcherWith({}).execute({ name: 'studio.nope.drop_tables', source: 'external-agent' })
    expect(result.ok).toBe(false)
    expect((await listCapabilityAudit())[0]).toMatchObject({ actionId: 'studio.nope.drop_tables', ok: false, source: 'external-agent' })
  })

  it('lets a read-only caller read, but never change anything or ask for approval', async () => {
    const save = vi.fn(() => ({}))
    const dispatcher = dispatcherWith({ 'manga.series.save': save, 'manga.series.list': () => ({ series: [] }) })
    dispatcher.requestApproval = async () => true
    expect((await dispatcher.execute({ name: 'manga.series.list', readOnly: true })).ok).toBe(true)
    const refused = await dispatcher.execute({ name: 'manga.series.save', arguments: { series: {} }, readOnly: true })
    expect(JSON.parse(refused.content).error).toContain('只能读取')
    expect(save).not.toHaveBeenCalled()
  })

  it('treats export as a change: held in a plan, never run by a read-only caller', () => {
    expect(isMutatingEffects(['export'])).toBe(true)
    expect(isMutatingEffects(['read', 'select'])).toBe(false)
  })

  it('asks before every destructive action an external Agent may take', () => {
    for (const id of [
      'manga.series.save',
      'training.projects.update',
      'training.dataset.set_caption',
      'training.runs.stop',
      'training.runs.start',
      'system.jobs.cancel',
      'remote.hosts.select',
      'studio.gbc.parse_image',
      'studio.gbc.start_job',
      'studio.gbc.job_cancel',
      'studio.projects.delete',
      'library.assets.trash',
      'models.catalog.delete',
    ]) {
      expect(BUILTIN_CAPABILITY_REGISTRY.getAction(id)?.descriptor.policyFloor, id).toBe('approval')
    }
  })

  it('asks for approval in 审批 mode too when the action changes nothing but still needs a yes', async () => {
    const run = vi.fn(() => ({ ok: true }))
    const registry = createBuiltinCapabilityRegistry()
    const descriptor = registry.getAction('system.window.focus')!.descriptor
    const approval = vi.fn(async () => false)
    const dispatcher = createMainCapabilityDispatcher({
      registry: {
        ...registry,
        getAction: () => ({ ...registry.getAction('system.window.focus')!, descriptor: { ...descriptor, policyFloor: 'approval' } }),
      },
      mainHandlers: { 'system.window.focus': run },
    })
    dispatcher.requestApproval = approval
    const result = await dispatcher.execute({ name: 'system.window.focus', mode: 'advanced', source: 'external-agent' })
    expect(result.ok).toBe(false)
    expect(approval).toHaveBeenCalledOnce()
    expect(run).not.toHaveBeenCalled()
  })

  it('drops a pending approval when the Agent goes away, and runs nothing after a late yes', async () => {
    const queue = createCapabilityApprovalQueue({ emit: () => undefined })
    const run = vi.fn(() => ({}))
    const dispatcher = dispatcherWith({ 'manga.series.delete': run })
    dispatcher.requestApproval = (request, signal) => queue.requestApproval(request, signal)
    const gone = new AbortController()
    const result = dispatcher.execute({
      name: 'manga.series.delete',
      arguments: { id: 's1' },
      source: 'external-agent',
      signal: gone.signal,
    })
    await vi.waitFor(() => expect(queue.listPending()).toHaveLength(1))
    const [pending] = queue.listPending()
    gone.abort()
    expect((await result).ok).toBe(false)
    expect(queue.listPending()).toEqual([])
    expect(queue.resolve(pending!.id, 'approve')).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('shows what a training run will really use in its approval', async () => {
    const approval = vi.fn(async (_request: { summary: string }) => false)
    const dispatcher = createMainCapabilityDispatcher({
      registry: createBuiltinCapabilityRegistry(),
      mainHandlers: { 'training.runs.start': () => ({}) },
      readFlags: () => ({ trainingEnabled: true }),
      approvalDetail: async (action, args) => (action.id === 'training.runs.start' ? `recipe of ${String(args.id)}` : undefined),
    })
    dispatcher.requestApproval = approval
    const result = await dispatcher.execute({ name: 'training.runs.start', arguments: { id: 'tp-abcd1' }, source: 'external-agent' })
    expect(result.content).toContain('未获批准')
    expect(approval.mock.calls[0]![0].summary).toContain('recipe of tp-abcd1')
  })
})

describe('the built-in dispatcher', () => {
  it('shows the recipe and the computer of a training run in its approval, and starts nothing without a yes', async () => {
    updateSettings({ trainingEnabled: true })
    vi.spyOn(trainingRun, 'trainingGet').mockResolvedValue({
      name: '阿明',
      hostId: 'local',
      recipe: { algo: 'lokr', dim: null, steps: 1200, batch: 2, resolution: 1024, overrides: '' },
    } as never)
    const start = vi.spyOn(trainingRun, 'trainingStart').mockResolvedValue({} as never)
    const dispatcher = createBuiltinMainDispatcher()
    const approval = vi.fn(async (_request: { summary: string }) => false)
    dispatcher.requestApproval = approval
    const result = await dispatcher.execute({ name: 'training.runs.start', arguments: { id: 'tp-aming' }, source: 'external-agent' })
    expect(result.ok).toBe(false)
    expect(approval.mock.calls[0]![0].summary).toContain('「阿明」在本机上训练：lokr · 1200 步 · batch 2 · 1024px')
    expect(start).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})

describe('approval queue', () => {
  it('keeps at most a few requests from one caller waiting', async () => {
    const queue = createCapabilityApprovalQueue({ emit: () => undefined, timeoutMs: 60_000 })
    const request = { actionId: 'a.b', packId: 'a', title: 't', summary: 's', argsPreview: '{}', source: 'external-agent' as const }
    for (let index = 0; index < MAX_PENDING_PER_SOURCE; index++) void queue.requestApproval(request)
    await expect(queue.requestApproval(request)).resolves.toBe(false)
    expect(queue.listPending()).toHaveLength(MAX_PENDING_PER_SOURCE)
    queue.clear()
  })
})

describe('files an external Agent names', () => {
  it('accepts a picture in 作品 or a project, as its real path', async () => {
    const outputs = join(root(), 'outputs')
    mkdirSync(outputs, { recursive: true })
    writeFileSync(join(outputs, 'a.png'), 'x')
    expect(await agentPicturePath(join(outputs, 'a.png'))).toBe(join(outputs, 'a.png'))
    const project = join(root(), 'projects', 'p1', 'assets')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'b.webp'), 'x')
    expect(await agentPicturePath(join(project, 'b.webp'))).toBe(join(project, 'b.webp'))
  })

  it('refuses network places, files elsewhere, links out of a gallery folder and non-pictures', async () => {
    await expect(agentPicturePath('\\\\attacker\\share\\x.png')).rejects.toThrow('网络位置')
    await expect(agentPicturePath('//attacker/share/x.png')).rejects.toThrow('网络位置')
    writeFileSync(join(outside(), 'secret.png'), 'x')
    await expect(agentPicturePath(join(outside(), 'secret.png'))).rejects.toThrow('作品库或项目')
    const outputs = join(root(), 'outputs')
    mkdirSync(outputs, { recursive: true })
    writeFileSync(join(outputs, 'notes.txt'), 'x')
    await expect(agentPicturePath(join(outputs, 'notes.txt'))).rejects.toThrow('图片')
    if (process.platform !== 'win32') {
      symlinkSync(join(outside(), 'secret.png'), join(outputs, 'link.png'))
      await expect(agentPicturePath(join(outputs, 'link.png'))).rejects.toThrow('作品库或项目')
    }
  })

  it('checks every file of a GBC job before it starts, and the handler never sees an unchecked path', async () => {
    const start = vi.fn(() => ({ id: 'job' }))
    const dispatcher = createMainCapabilityDispatcher({
      registry: createBuiltinCapabilityRegistry(),
      mainHandlers: { 'studio.gbc.start_job': start },
      readFlags: () => ({ gbcEnabled: true }),
      prepareArgs: prepareAgentPaths,
    })
    dispatcher.requestApproval = async () => true
    const result = await dispatcher.execute({
      name: 'studio.gbc.start_job',
      arguments: { files: ['//nas/photos/1.png'], providerId: 'p' },
      source: 'external-agent',
    })
    expect(result.ok).toBe(false)
    expect(start).not.toHaveBeenCalled()
  })
})

describe('system.jobs.* and reviews', () => {
  it('reads logs only of a job the app knows, by an id that cannot leave the jobs folder', async () => {
    const logs = vi.spyOn(supervisor, 'getJobLogs').mockResolvedValue([])
    vi.spyOn(supervisor, 'getJob').mockImplementation(async (id) => (id === 'job-1' ? ({ id } as never) : null))
    const handlers = createBuiltinMainHandlers()
    const context = { callId: 'c', action: {} as never, source: 'external-agent' as const }
    await expect(handlers['system.jobs.logs']!({ id: '../../secrets' }, context)).rejects.toThrow('任务不存在')
    await expect(handlers['system.jobs.logs']!({ id: 'job-2' }, context)).rejects.toThrow('任务不存在')
    await handlers['system.jobs.logs']!({ id: 'job-1' }, context)
    expect(logs).toHaveBeenCalledExactlyOnceWith('job-1')
    vi.restoreAllMocks()
  })
})

describe('audit trail', () => {
  const entry = (id: string, source: 'external-agent' | 'ipc' = 'external-agent') => ({
    id,
    timestamp: new Date().toISOString(),
    source,
    actionId: 'studio.projects.list' as const,
    packId: 'studio.projects' as const,
    target: 'main' as const,
    effects: ['read' as const],
    policyFloor: 'auto' as const,
    mode: 'auto' as const,
    approved: false,
    summary: 'x'.repeat(100),
    ok: true,
    durationMs: 1,
  })

  it('shows Agents only external Agents’ calls when asked by source', async () => {
    recordCapabilityAudit(entry('a'))
    recordCapabilityAudit(entry('b', 'ipc'))
    expect((await listCapabilityAudit({ source: 'external-agent' })).map((item) => item.id)).toEqual(['a'])
  })

  it('writes off the main thread and starts a new file at the size cap, keeping one before it', async () => {
    const lines = Math.ceil(MAX_AUDIT_FILE_BYTES / JSON.stringify(entry('x')).length) + 5
    for (let index = 0; index < lines; index++) recordCapabilityAudit(entry(`e${index}`))
    await flushCapabilityAudit()
    expect(statSync(paths.capabilityAudit()).size).toBeLessThanOrEqual(MAX_AUDIT_FILE_BYTES)
    expect(statSync(`${paths.capabilityAudit()}.1`).size).toBeGreaterThan(0)
    expect(readFileSync(paths.capabilityAudit(), 'utf8').trim().split('\n').length).toBeGreaterThan(0)
  })

  it('reads the earlier run’s entries back from the end of the file after a restart', async () => {
    recordCapabilityAudit(entry('before-restart'))
    await flushCapabilityAudit()
    resetCapabilityAuditMemory()
    expect((await listCapabilityAudit()).map((item) => item.id)).toEqual(['before-restart'])
  })
})
