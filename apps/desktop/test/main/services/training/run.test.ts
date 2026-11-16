import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  sshCommands: [] as string[],
  remoteBusy: false,
  /** The state the started job is in by the time trainingStart looks at it again. */
  jobStateAfterStart: 'running' as JobRecord['state'],
  ready: true,
  /** Holds trainingReadiness (inside the start) until released. */
  readinessGate: Promise.resolve() as Promise<void>,
  scpGate: Promise.resolve() as Promise<void>,
  /** Holds every SSH command until released. */
  sshGate: Promise.resolve() as Promise<void>,
}
const registerTrainedAdapter = vi.fn(async (_settings: unknown, input: { id: string; sourcePath?: string }) => ({ id: input.id }))
const startTrainingJob = vi.fn(async (input: { totalSteps?: number }) => {
  const job = jobFixture({ id: 'train-1', kind: 'training', mode: 'training', state: 'running' } as Partial<JobRecord>)
  job.progress = { stage: 'denoise', current: 0, total: input.totalSteps ?? 0, percent: 0 }
  state.jobs.set(job.id, { ...job, state: state.jobStateAfterStart })
  return job
})
const notifications = vi.fn()
const emitted: Array<{ channel: string; payload: unknown }> = []
const scpFrom = vi.fn(async (_host: unknown, source: string, target: string) => {
  await state.scpGate
  writeFileSync(target, `remote weights from ${source}`)
  return { code: 0, stdout: '', stderr: '', timedOut: false }
})

vi.mock('@main/lib/events', () => ({ emit: (channel: string, payload: unknown) => emitted.push({ channel, payload }) }))
vi.mock('@main/services/settings', () => ({ getSettings: () => settingsFixture() }))
vi.mock('@main/services/desktopNotifications', () => ({ pushLocalNotification: (input: unknown) => notifications(input) }))
vi.mock('@main/services/models', () => ({
  registerTrainedAdapter: (...args: [unknown, { id: string; sourcePath?: string }]) => registerTrainedAdapter(...args),
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
    state.sshCommands.push(command)
    await state.sshGate
    if (command.includes('/run.pid; do')) return { code: 0, stdout: state.remoteBusy ? 'busy\n' : '', stderr: '', timedOut: false }
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
  trainingReadiness: async () => {
    await state.readinessGate
    return { ready: state.ready }
  },
}))
vi.mock('@main/services/training/weights', () => ({
  comfyWeightsFolder: () => '/models/training-weights/moss-base-int8',
  localWeightsFolder: async () => ({ bundleId: 'moss-base-int8', path: '/models/training-weights/moss-base-int8' }),
  plannedWeightsFolder: async () => ({ bundleId: 'moss-base-int8', path: '/models/training-weights/moss-base-int8' }),
}))

const root = useTempDataRoot()

beforeEach(() => {
  vi.resetModules()
  state.jobs.clear()
  state.logs = []
  state.remoteFiles.clear()
  state.sshCommands = []
  state.remoteBusy = false
  state.jobStateAfterStart = 'running'
  state.ready = true
  state.readinessGate = Promise.resolve()
  state.scpGate = Promise.resolve()
  state.sshGate = Promise.resolve()
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
    dataset: await import('@main/services/training/dataset'),
  }
}

/** A draft for `mira` with three pictures, one without a description and one without the trigger. */
async function draftWithPictures(hostId = 'local') {
  const { run, store, dataset } = await load()
  const project = await store.createTrainingProject({ kind: 'person', hostId, samples: true })
  await store.updateTrainingProject(project.id, { trigger: 'mira' })
  const images = join(root(), 'training', project.id, 'images')
  writeFileSync(join(images, 'a.png'), pngBytes(1024, 1024, 1))
  writeFileSync(join(images, 'b.png'), pngBytes(1024, 1024, 2))
  writeFileSync(join(images, 'b.txt'), '坐在窗边')
  writeFileSync(join(images, 'c.png'), pngBytes(1024, 1024, 3))
  writeFileSync(join(images, 'c.txt'), 'mira, smiling')
  return { run, store, dataset, project, images }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setTimeout(resolve, 5))
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
    expect(failed).toMatchObject({ state: 'done', chosenStep: null, adapterId: null, saveErrorStep: 1000 })
    expect(failed.saveError).toContain('1000')
    expect(registerTrainedAdapter).not.toHaveBeenCalled()

    put(join(runDir, 'checkpoints', 'step_00000500', 'export', 'mira-abc123-comfy.safetensors'))
    const chosen = await run.trainingChooseStep(project.id, 500)
    expect(registerTrainedAdapter.mock.calls[0]![1]).toMatchObject({
      id: `trained-${project.id}`,
      sourcePath: join(runDir, 'checkpoints', 'step_00000500', 'export', 'mira-abc123-comfy.safetensors'),
    })
    expect(chosen).toMatchObject({ chosenStep: 500, saveError: null, saveErrorStep: null, adapterId: `trained-${project.id}` })
  })

  it('reports a registration failure as saveError', async () => {
    const { run, project, runDir } = await running({ state: 'done' })
    put(join(runDir, 'checkpoints', 'step_00000250', 'export', 'mira-abc123-comfy.safetensors'))
    registerTrainedAdapter.mockRejectedValueOnce(new Error('ENOSPC'))
    const result = await run.trainingChooseStep(project.id, 250)
    expect(result.saveError).toContain('第 250 步')
    expect(result).toMatchObject({ chosenStep: null, saveErrorStep: 250 })
  })

  it('keeps the saved step when saving another one fails, and names the step that failed', async () => {
    const { run, project, runDir } = await running({ state: 'done' })
    put(join(runDir, 'export', 'mira-abc123-comfy.safetensors'))
    await run.trainingChooseStep(project.id, 1000)
    const failed = await run.trainingChooseStep(project.id, 500)
    expect(failed).toMatchObject({ chosenStep: 1000, adapterId: `trained-${project.id}`, saveErrorStep: 500 })
    expect(failed.saveError).toContain('500')
  })

  it('saves one step at a time per training, each download under its own name', async () => {
    const { run, store, project } = await running({ hostId: 'ssh-gpu', state: 'done' })
    state.remoteFiles.add('checkpoints/step_00000250/export/mira-abc123-comfy.safetensors')
    state.remoteFiles.add('checkpoints/step_00000500/export/mira-abc123-comfy.safetensors')
    let release = (): void => undefined
    state.scpGate = new Promise<void>((resolve) => (release = resolve))
    const first = run.trainingChooseStep(project.id, 250)
    const second = run.trainingChooseStep(project.id, 500)
    await settle()
    expect(scpFrom).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, second])
    const targets = scpFrom.mock.calls.map((call) => call[2])
    expect(targets).toEqual([
      join(root(), 'training', project.id, 'download', 'step_00000250', 'mira-abc123-comfy.safetensors'),
      join(root(), 'training', project.id, 'download', 'step_00000500', 'mira-abc123-comfy.safetensors'),
    ])
    expect(registerTrainedAdapter.mock.calls.map((call) => call[1].sourcePath)).toEqual(targets)
    expect(await store.getTrainingProject(project.id)).toMatchObject({ chosenStep: 500, saveError: null })
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

  it('ends a remote trainer whose SSH session failed, so it does not keep the GPU', async () => {
    const { run, store, project } = await running({ hostId: 'ssh-gpu' })
    await run.onTrainingJobEnded(ended('failed', 300, { code: 'E_EXIT', message: 'Connection reset by peer' }))
    expect(state.sshCommands.some((command) => command.includes(`/training/${project.id}/run.pid`) && command.includes('kill -TERM'))).toBe(
      true,
    )
    expect((await store.getTrainingProject(project.id)).state).toBe('failed')
  })

  it('lists trainings without waiting for a remote host to settle a run that ended', async () => {
    const { run, store, project } = await running({ hostId: 'ssh-gpu' })
    ended('succeeded')
    let release = (): void => undefined
    state.sshGate = new Promise<void>((resolve) => (release = resolve))
    await run.trainingList()
    expect((await store.getTrainingProject(project.id)).state).toBe('running')
    release()
    await settle()
    expect((await store.getTrainingProject(project.id)).state).toBe('done')
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
      sourcePath: join(root(), 'training', project.id, 'download', 'step_00000750', 'mira-abc123-comfy.safetensors'),
    })
    expect(result.chosenStep).toBe(750)
    expect((await store.getTrainingProject(project.id)).saveError).toBeNull()
  })
})

describe('training samples', () => {
  it('leaves out a step whose pictures are still being written (no settings.json yet)', async () => {
    const { run, project, runDir } = await running({ state: 'stopped' })
    put(join(runDir, 'samples', 'step_00000000', '000.png'))
    put(join(runDir, 'samples', 'step_00000000', 'settings.json'), '{}')
    put(join(runDir, 'samples', 'step_00000250', '000.png'))
    expect((await run.trainingSamples(project.id)).columns.map((column) => column.step)).toEqual([0])
  })

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
  it("runs one local job on the largest card, the trigger in every description it trains on, the person's own untouched", async () => {
    const { run, project, images } = await draftWithPictures()

    const started = await run.trainingStart(project.id)

    expect(started).toMatchObject({ state: 'running', jobId: 'train-1', runName: `mira-${project.id.split('-').pop()}` })
    const staged = join(root(), 'training', project.id, 'dataset')
    expect(readFileSync(join(staged, 'a.txt'), 'utf8')).toBe('mira\n')
    expect(readFileSync(join(staged, 'b.txt'), 'utf8')).toBe('mira，坐在窗边\n')
    expect(readFileSync(join(staged, 'c.txt'), 'utf8')).toBe('mira, smiling\n')
    expect(readFileSync(join(staged, 'a.png'))).toEqual(readFileSync(join(images, 'a.png')))
    expect(existsSync(join(images, 'a.txt'))).toBe(false)
    expect(readFileSync(join(images, 'b.txt'), 'utf8')).toBe('坐在窗边')
    const input = startTrainingJob.mock.calls[0]![0] as unknown as {
      command: string
      args: string[]
      env: Record<string, string>
      totalSteps: number
    }
    expect(input.totalSteps).toBe(project.recipe.steps)
    expect(input.env).toEqual({ CUDA_DEVICE_ORDER: 'PCI_BUS_ID', CUDA_VISIBLE_DEVICES: '1' })
    const script = readFileSync(input.args.at(-1)!, 'utf8')
    expect(script).toContain(`--data ${staged}`)
    expect(script).toContain(`--out ${join(root(), 'training', project.id, 'configs', `${started.runName}.py`)}`)
    expect(script).toContain('/trainer/runtimes/tr-1/bin/kogine run scripts/train/moss.py')
    // The job's own environment leaves PYTHONPATH to the script, which puts this version's code first.
    expect(input.env).not.toHaveProperty('PYTHONPATH')
    expect(script).toContain(`export PYTHONPATH='/trainer/versions/kohaku-abc1234/src'"\${PYTHONPATH:+:$PYTHONPATH}"`)
    expect(await run.trainingCommand(project.id)).toBe(script)
    await expect(run.trainingStart(project.id)).rejects.toMatchObject({ code: 'E_TRAINING_RUNNING' })
  })

  it('is starting while it prepares: a second start, edits, picture changes and deleting are refused', async () => {
    const { run, store, dataset, project } = await draftWithPictures()
    let release = (): void => undefined
    state.readinessGate = new Promise<void>((resolve) => (release = resolve))
    const starting = run.trainingStart(project.id)
    await settle()

    expect((await store.getTrainingProject(project.id)).state).toBe('starting')
    expect(
      emitted.some((event) => event.channel === Events.trainingChanged && (event.payload as TrainingProject).state === 'starting'),
    ).toBe(true)
    await expect(run.trainingStart(project.id)).rejects.toMatchObject({ code: 'E_TRAINING_RUNNING' })
    await expect(store.updateTrainingProject(project.id, { name: 'x' })).rejects.toMatchObject({ code: 'E_TRAINING_RUNNING' })
    await expect(dataset.setCaption(project.id, 'a.png', 'x')).rejects.toMatchObject({ code: 'E_TRAINING_RUNNING' })
    await expect(dataset.writeCaptions(project.id, new Map([['a.png', 'x']]))).rejects.toMatchObject({ code: 'E_TRAINING_RUNNING' })
    await expect(dataset.removeFromDataset(project.id, ['a.png'])).rejects.toMatchObject({ code: 'E_TRAINING_RUNNING' })
    await expect(store.removeTrainingProject(project.id)).rejects.toMatchObject({ code: 'E_TRAINING_RUNNING' })
    // A list while it starts does not take it for a start the app lost.
    await run.trainingList()
    expect((await store.getTrainingProject(project.id)).state).toBe('starting')

    release()
    expect((await starting).state).toBe('running')
  })

  it('goes back to a draft, descriptions untouched, when the start fails', async () => {
    const { run, store, project, images } = await draftWithPictures()
    state.ready = false
    await expect(run.trainingStart(project.id)).rejects.toMatchObject({ code: 'E_TRAINING_NOT_READY' })
    expect((await store.getTrainingProject(project.id)).state).toBe('draft')
    expect(existsSync(join(images, 'a.txt'))).toBe(false)
    expect(readFileSync(join(images, 'b.txt'), 'utf8')).toBe('坐在窗边')
    expect(startTrainingJob).not.toHaveBeenCalled()
  })

  it('settles a job that ended before its id was saved', async () => {
    const { run, store, project } = await draftWithPictures()
    state.jobStateAfterStart = 'failed'
    state.logs = ['bash: /trainer/runtimes/tr-1/bin/kohakumoss-config: No such file or directory']
    const result = await run.trainingStart(project.id)
    expect(result.state).toBe('failed')
    expect((await store.getTrainingProject(project.id)).failure).toContain('找不到')
  })

  it('marks a training that was starting when the app closed as failed, in plain words', async () => {
    const { run, store, project } = await draftWithPictures()
    await store.mutateTrainingProject(project.id, (current) => ({ ...current, state: 'starting' }))
    await run.trainingList()
    const settled = await store.getTrainingProject(project.id)
    expect(settled.state).toBe('failed')
    expect(settled.failure).toContain('应用在准备时关闭')
  })

  it('refuses a remote start while a trainer this app started still runs on the host, and goes back to a draft', async () => {
    const { run, store, project } = await draftWithPictures('ssh-gpu')
    state.remoteBusy = true
    await expect(run.trainingStart(project.id)).rejects.toMatchObject({ code: 'E_TRAINING_BUSY' })
    expect(state.sshCommands.find((command) => command.includes('/run.pid; do'))).toContain(
      "'/home/moss/.mossstudio/trainer'/training/*/run.pid",
    )
    expect((await store.getTrainingProject(project.id)).state).toBe('draft')
    expect(startTrainingJob).not.toHaveBeenCalled()
  })

  it('knows which trainer version a starting or running training uses', async () => {
    const { run, project } = await draftWithPictures()
    let release = (): void => undefined
    state.readinessGate = new Promise<void>((resolve) => (release = resolve))
    const starting = run.trainingStart(project.id)
    await settle()
    expect(await run.trainerVersionInUse('kohaku-abc1234')).toBe(false)
    release()
    await starting
    state.jobs.set('train-1', { ...state.jobs.get('train-1')!, trainerVersionId: 'kohaku-abc1234' })
    expect(await run.trainerVersionInUse('kohaku-abc1234')).toBe(true)
    expect(await run.trainerVersionInUse('kohaku-other')).toBe(false)
  })

  it('refuses to start without pictures', async () => {
    const { run, store } = await load()
    const project = await store.createTrainingProject({ kind: 'style', samples: true })
    await expect(run.trainingStart(project.id)).rejects.toMatchObject({ code: 'E_TRAINING_EMPTY' })
    expect((await store.getTrainingProject(project.id)).state).toBe('draft')
  })

  it('names later runs of the same training apart', async () => {
    const { run } = await load()
    const base = { id: 'tp-abc-x1y2z3', kind: 'person' as const, trigger: 'mira' }
    expect(run.nextRunName({ ...base, runName: null })).toBe('mira-x1y2z3')
    expect(run.nextRunName({ ...base, runName: 'mira-x1y2z3' })).toBe('mira-x1y2z3-2')
    expect(run.nextRunName({ ...base, runName: 'mira-x1y2z3-2' })).toBe('mira-x1y2z3-3')
    expect(run.nextRunName({ ...base, trigger: '', kind: 'style', runName: null })).toBe('style-x1y2z3')
  })
})
