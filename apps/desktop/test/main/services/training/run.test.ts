import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Events } from '@shared/channels'
import type { TrainingProject } from '@shared/training'
import type { JobRecord, TrainerVersion } from '@shared/types'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { jobFixture, settingsFixture, sshHostFixture } from '@test/mocks/backend/fixtures'
import { pngBytes } from './pictures'

const state = {
  jobs: new Map<string, JobRecord>(),
  logs: [] as string[],
  remoteFiles: new Set<string>(),
}
const registerTrainedAdapter = vi.fn(async (_settings: unknown, input: { id: string }) => ({ id: input.id }))
const startTrainingJob = vi.fn(async (input: { totalSteps?: number }) => {
  const job = jobFixture({ id: 'train-1', kind: 'training', mode: 'training', state: 'running' } as Partial<JobRecord>)
  job.progress = { stage: 'denoise', current: 0, total: input.totalSteps ?? 0, percent: 0 }
  state.jobs.set(job.id, job)
  return job
})
const notifications = vi.fn()
const emitted: Array<{ channel: string; payload: unknown }> = []
const scpFrom = vi.fn(async (_host: unknown, _source: string, target: string) => {
  writeFileSync(target, 'remote weights')
  return { code: 0, stdout: '', stderr: '', timedOut: false }
})

vi.mock('@main/lib/events', () => ({ emit: (channel: string, payload: unknown) => emitted.push({ channel, payload }) }))
vi.mock('@main/services/settings', () => ({ getSettings: () => settingsFixture() }))
vi.mock('@main/services/desktopNotifications', () => ({ pushLocalNotification: (input: unknown) => notifications(input) }))
vi.mock('@main/services/models', () => ({
  registerTrainedAdapter: (...args: [unknown, { id: string }]) => registerTrainedAdapter(...args),
  resolveAdapterFile: async () => null,
}))
vi.mock('@main/services/supervisor', () => ({
  getJob: async (id: string) => state.jobs.get(id) ?? null,
  getJobLogs: async () => state.logs.map((text, seq) => ({ jobId: 'train-1', seq, at: '', stream: 'stderr', text })),
  listJobs: async () => [...state.jobs.values()],
  cancelJob: async (id: string) => state.jobs.get(id) ?? null,
  startTrainingJob: (input: { totalSteps?: number }) => startTrainingJob(input),
}))
vi.mock('@main/services/trainers', () => ({
  listTrainerVersions: async () => [
    {
      id: 'kohaku-abc1234',
      hostId: 'local',
      path: '/trainer/versions/kohaku-abc1234',
      status: 'ok',
      runtimeState: 'ready',
    } as TrainerVersion,
  ],
  trainerRuntimeSummary: async () => ({ id: 'tr-1', path: '/trainer/runtimes/tr-1', state: 'ready' }),
}))
vi.mock('@main/services/remoteTrainer', () => ({
  remoteSetup: () => 'ROOT="$HOME/.mossstudio/trainer"',
  remoteVersions: () => [{ id: 'remote-ssh-gpu-abc1234', hostId: 'ssh-gpu', runtimeId: 'tr-r', status: 'ok', runtimeState: 'ready' }],
  rootExpression: (path: string) => `'${path}'`,
}))
vi.mock('@main/services/trainingHosts', () => ({
  getTrainingHost: (_settings: unknown, id: string) => (id === 'ssh-gpu' ? sshHostFixture({ weightsPath: '/models' }) : undefined),
}))
vi.mock('@main/services/ssh', () => ({
  posixQuote: (value: string) => `'${value.replace(/'/g, `'\\''`)}'`,
  sshExec: async (_host: unknown, command: string) => {
    if (command.includes('pwd -P')) return { code: 0, stdout: '/home/moss/.mossstudio/trainer\n', stderr: '', timedOut: false }
    const found = [...state.remoteFiles].find((file) => command.includes(`if [ -f '${file}' ]`))
    return { code: 0, stdout: found ? `${found}\n` : '', stderr: '', timedOut: false }
  },
  scpFrom: (...args: [unknown, string, string]) => scpFrom(...args),
  scpTo: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
  sshArgs: (_host: unknown, command: string) => [command],
  sshCommand: () => 'ssh',
  sshEnv: () => ({}),
  sshWriteFile: async () => undefined,
}))
vi.mock('@main/services/training/readiness', () => ({
  installedBaseBundle: async () => ({ id: 'moss-base-int8' }),
  localTrainingGpu: async () => ({ index: 1, name: 'RTX', memoryTotalBytes: 24 * 1024 ** 3 }),
  samplesByDefault: async () => true,
  trainingReadiness: async () => ({ ready: true }),
}))
vi.mock('@main/services/training/weights', () => ({
  comfyWeightsFolder: () => '/models/training-weights/moss-base-int8',
  localWeightsFolder: async () => ({ bundleId: 'moss-base-int8', path: '/models/training-weights/moss-base-int8' }),
}))

const root = useTempDataRoot()

beforeEach(() => {
  vi.resetModules()
  state.jobs.clear()
  state.logs = []
  state.remoteFiles.clear()
  emitted.length = 0
  registerTrainedAdapter.mockClear()
  startTrainingJob.mockClear()
  notifications.mockClear()
  scpFrom.mockClear()
})

async function load() {
  return {
    run: await import('@main/services/training/run'),
    store: await import('@main/services/training/store'),
  }
}

/** A training whose run `trigger-xxxx` is going (job train-1). */
async function running(patch: Partial<TrainingProject> = {}) {
  const { run, store } = await load()
  const created = await store.createTrainingProject({ kind: 'person', samples: true })
  const project = await store.mutateTrainingProject(created.id, (current) => ({
    ...current,
    trigger: 'mira',
    state: 'running',
    jobId: 'train-1',
    runName: 'mira-abc123',
    recipe: { ...current.recipe, steps: 1000, sampleEvery: 250 },
    ...patch,
  }))
  const runDir = join(root(), 'training', project.id, 'runs', 'mira-abc123')
  return { run, store, project, runDir }
}

function ended(stateName: JobRecord['state'], current = 1000, error?: JobRecord['error']): JobRecord {
  const job = jobFixture({ id: 'train-1', kind: 'training', state: stateName, error } as Partial<JobRecord>)
  job.progress = { stage: 'denoise', current, total: 1000, percent: 0 }
  state.jobs.set(job.id, job)
  return job
}

function put(path: string, content = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

describe('training run end', () => {
  it("saves the finished run's -comfy export as the trained-<training id> LoRA, named after the training", async () => {
    const { run, store, project, runDir } = await running({ name: '米拉' })
    put(join(runDir, 'export', 'mira-abc123-comfy.safetensors'))
    put(join(runDir, 'export', 'mira-abc123-lycoris.safetensors'))

    await run.onTrainingJobEnded(ended('succeeded'))

    expect(registerTrainedAdapter).toHaveBeenCalledWith(expect.anything(), {
      id: `trained-${project.id}`,
      name: '米拉',
      sourcePath: join(runDir, 'export', 'mira-abc123-comfy.safetensors'),
      kind: 'lora',
      base: 'moss-base-int8',
      license: 'local',
    })
    expect(await store.getTrainingProject(project.id)).toMatchObject({
      state: 'done',
      chosenStep: 1000,
      stepReached: 1000,
      adapterId: `trained-${project.id}`,
      saveError: null,
    })
    expect(notifications).toHaveBeenCalledWith(expect.objectContaining({ title: '训练完成', route: '/training' }))
    expect(emitted.filter((event) => event.channel === Events.trainingChanged).length).toBeGreaterThanOrEqual(2)
  })

  it('writes why the LoRA could not be saved instead of failing silently, and a later choice clears it', async () => {
    const { run, store, project, runDir } = await running()
    await run.onTrainingJobEnded(ended('succeeded'))

    const failed = await store.getTrainingProject(project.id)
    expect(failed).toMatchObject({ state: 'done', chosenStep: null, adapterId: null })
    expect(failed.saveError).toContain('1000')
    expect(registerTrainedAdapter).not.toHaveBeenCalled()

    put(join(runDir, 'checkpoints', 'step_00000500', 'export', 'mira-abc123-comfy.safetensors'))
    const chosen = await run.trainingChooseStep(project.id, 500)
    expect(registerTrainedAdapter.mock.calls[0]![1]).toMatchObject({
      id: `trained-${project.id}`,
      sourcePath: join(runDir, 'checkpoints', 'step_00000500', 'export', 'mira-abc123-comfy.safetensors'),
    })
    expect(chosen).toMatchObject({ chosenStep: 500, saveError: null, adapterId: `trained-${project.id}` })
  })

  it('reports a registration failure as saveError', async () => {
    const { run, project, runDir } = await running({ state: 'done' })
    put(join(runDir, 'checkpoints', 'step_00000250', 'export', 'mira-abc123-comfy.safetensors'))
    registerTrainedAdapter.mockRejectedValueOnce(new Error('ENOSPC'))
    const result = await run.trainingChooseStep(project.id, 250)
    expect(result.saveError).toContain('第 250 步')
    expect(result.chosenStep).toBeNull()
  })

  it('marks a failed run with the reason read from its log, and tells the person', async () => {
    const { run, store, project, runDir } = await running()
    put(join(runDir, 'checkpoints', 'step_00000250', 'export', 'mira-abc123-comfy.safetensors'))
    state.logs = ['step 300 loss=0.1', 'torch.OutOfMemoryError: CUDA out of memory.']
    await run.onTrainingJobEnded(ended('failed', 300))
    const failed = await store.getTrainingProject(project.id)
    expect(failed).toMatchObject({ state: 'failed', stepReached: 300 })
    expect(failed.failure).toContain('显存不够')
    expect(notifications).toHaveBeenCalledWith(expect.objectContaining({ title: '训练没有完成' }))
  })

  it('marks a stopped run as stopped, its checkpoints still choosable', async () => {
    const { run, store, project, runDir } = await running()
    put(join(runDir, 'checkpoints', 'step_00000500', 'export', 'mira-abc123-comfy.safetensors'))
    await run.onTrainingJobEnded(ended('canceled', 420))
    expect(await store.getTrainingProject(project.id)).toMatchObject({ state: 'stopped', stepReached: 500 })
    expect((await run.trainingSamples(project.id)).checkpoints).toEqual([500])
    expect(notifications).not.toHaveBeenCalled()
  })

  it('settles a training whose job was interrupted by a restart when it is listed', async () => {
    const { run, store, project } = await running()
    ended('failed', 10, { code: 'E_INTERRUPTED', message: '应用重启，任务已中断' })
    await run.trainingList()
    expect((await store.getTrainingProject(project.id)).failure).toContain('应用关闭')
  })

  it('copies a remote step down first and registers that copy', async () => {
    const { run, store, project } = await running({ hostId: 'ssh-gpu', state: 'done' })
    state.remoteFiles.add('checkpoints/step_00000750/export/mira-abc123-comfy.safetensors')
    const result = await run.trainingChooseStep(project.id, 750)
    expect(scpFrom.mock.calls[0]![1]).toBe(
      `/home/moss/.mossstudio/trainer/training/${project.id}/runs/mira-abc123/checkpoints/step_00000750/export/mira-abc123-comfy.safetensors`,
    )
    expect(registerTrainedAdapter.mock.calls[0]![1]).toMatchObject({
      sourcePath: join(root(), 'training', project.id, 'download', 'mira-abc123-comfy.safetensors'),
    })
    expect(result.chosenStep).toBe(750)
    expect((await store.getTrainingProject(project.id)).saveError).toBeNull()
  })
})

describe('training samples', () => {
  it('lists sample columns per step (step 0 first) in prompt order, the checkpoints and the next sampled step', async () => {
    const { run, project, runDir } = await running()
    for (const step of ['00000000', '00000250']) {
      put(join(runDir, 'samples', `step_${step}`, '001.png'))
      put(join(runDir, 'samples', `step_${step}`, '000.png'))
      put(join(runDir, 'samples', `step_${step}`, 'sheet.png'))
      put(join(runDir, 'samples', `step_${step}`, 'settings.json'), '{}')
    }
    put(join(runDir, 'checkpoints', 'step_00000250', 'export', 'mira-abc123-comfy.safetensors'))
    mkdirSync(join(runDir, 'checkpoints', 'step_00000500'), { recursive: true })
    ended('running', 300)

    const samples = await run.trainingSamples(project.id)

    expect(samples.columns).toEqual([
      { step: 0, images: [join(runDir, 'samples', 'step_00000000', '000.png'), join(runDir, 'samples', 'step_00000000', '001.png')] },
      { step: 250, images: [join(runDir, 'samples', 'step_00000250', '000.png'), join(runDir, 'samples', 'step_00000250', '001.png')] },
    ])
    expect(samples.checkpoints).toEqual([250])
    expect(samples.nextStep).toBe(500)
    expect(samples.prompts).toEqual(project.recipe.samplePrompts)
    expect((await run.trainingGet(project.id)).cover).toBe(join(runDir, 'samples', 'step_00000250', '000.png'))
  })
})

describe('training start', () => {
  it('runs one local job with the trigger in every description and the largest card', async () => {
    const { run, store } = await load()
    const project = await store.createTrainingProject({ kind: 'person', samples: true })
    await store.updateTrainingProject(project.id, { trigger: 'mira' })
    const images = join(root(), 'training', project.id, 'images')
    writeFileSync(join(images, 'a.png'), pngBytes(1024, 1024, 1))
    writeFileSync(join(images, 'b.png'), pngBytes(1024, 1024, 2))
    writeFileSync(join(images, 'b.txt'), '坐在窗边')
    writeFileSync(join(images, 'c.png'), pngBytes(1024, 1024, 3))
    writeFileSync(join(images, 'c.txt'), 'mira, smiling')

    const started = await run.trainingStart(project.id)

    expect(started).toMatchObject({ state: 'running', jobId: 'train-1', runName: `mira-${project.id.split('-').pop()}` })
    expect(readFileSync(join(images, 'a.txt'), 'utf8')).toBe('mira\n')
    expect(readFileSync(join(images, 'b.txt'), 'utf8')).toBe('mira，坐在窗边\n')
    expect(readFileSync(join(images, 'c.txt'), 'utf8')).toBe('mira, smiling')
    const input = startTrainingJob.mock.calls[0]![0] as unknown as {
      command: string
      args: string[]
      env: Record<string, string>
      totalSteps: number
    }
    expect(input.totalSteps).toBe(project.recipe.steps)
    expect(input.env).toEqual({ CUDA_DEVICE_ORDER: 'PCI_BUS_ID', CUDA_VISIBLE_DEVICES: '1' })
    const script = readFileSync(input.args.at(-1)!, 'utf8')
    expect(script).toContain(`--data ${images}`)
    expect(script).toContain('/trainer/runtimes/tr-1/bin/kogine run scripts/train/moss.py')
    expect(await run.trainingCommand(project.id)).toBe(script)
    await expect(run.trainingStart(project.id)).rejects.toMatchObject({ code: 'E_TRAINING_RUNNING' })
  })

  it('refuses to start without pictures', async () => {
    const { run, store } = await load()
    const project = await store.createTrainingProject({ kind: 'style', samples: true })
    await expect(run.trainingStart(project.id)).rejects.toMatchObject({ code: 'E_TRAINING_EMPTY' })
  })

  it('names later runs of the same training apart and finds the trigger as a word of its own', async () => {
    const { run } = await load()
    const base = { id: 'tp-abc-x1y2z3', kind: 'person' as const, trigger: 'mira' }
    expect(run.nextRunName({ ...base, runName: null })).toBe('mira-x1y2z3')
    expect(run.nextRunName({ ...base, runName: 'mira-x1y2z3' })).toBe('mira-x1y2z3-2')
    expect(run.nextRunName({ ...base, runName: 'mira-x1y2z3-2' })).toBe('mira-x1y2z3-3')
    expect(run.nextRunName({ ...base, trigger: '', kind: 'style', runName: null })).toBe('style-x1y2z3')
    expect(run.mentionsTrigger('mira，坐着', 'mira')).toBe(true)
    expect(run.mentionsTrigger('miranda stands', 'mira')).toBe(false)
  })
})
