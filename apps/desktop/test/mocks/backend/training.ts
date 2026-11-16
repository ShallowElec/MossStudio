/**
 * 训练 handlers of the mock backend, mirroring main/services/training. Data-driven
 * through `state.training`:
 *
 *   state.training.readiness        what training:readiness answers for 本机 (remote hosts read as ready)
 *   state.training.projects         the trainings, any state
 *   state.training.datasets[id]     a training's pictures
 *   state.training.samples[id]      a training's sample pictures per step
 *   state.training.captionError     自动写描述 answers this error instead of writing descriptions
 *   state.training.saveError        saving a chosen step fails with this reason
 *   state.training.startError       after 'starting', the start fails with this reason (E_TRAINING_UPLOAD) and goes back to 'draft'
 *   state.training.prepareStepMs    pause between the steps training:prepare plays (download, trainer, environment)
 *   state.training.startMs          how long training:start stays 'starting' (pictures uploaded) before the job runs;
 *                                   null = until `runStarted` (the start call answers only then, as main's does)
 *
 * Codes and messages are main's (main/services/training/store.ts, run.ts).
 *
 * Picture paths carry their pixel size (`-384x288`), which the E2E protocol handler draws.
 */
import { Events, Ipc } from '@shared/channels'
import {
  SMALL_PICTURE_SIDE,
  presetRecipe,
  triggerFrom,
  type DatasetImage,
  type TrainingCaptionResult,
  type TrainingDataset,
  type TrainingKind,
  type TrainingProject,
  type TrainingReadiness,
  type TrainingSamples,
} from '@shared/training'
import type { AdapterEntry, Catalog, DownloadTask, JobRecord, ManagedHost } from '@shared/types'

const GiB = 1024 ** 3
const NOW = '2026-11-01T00:00:00.000Z'
const BASE_BYTES = 10_164_704_750

export interface MockTrainingState {
  readiness: TrainingReadiness
  projects: TrainingProject[]
  datasets: Record<string, DatasetImage[]>
  samples: Record<string, TrainingSamples>
  captionError: string | null
  saveError: string | null
  startError: string | null
  prepareStepMs: number
  /** How long a started training stays `starting` before its job runs; null keeps it starting. */
  startMs: number | null
  /** Next number for a new training's id. */
  nextId: number
}

export function trainingReadinessFixture(patch: Partial<TrainingReadiness> = {}): TrainingReadiness {
  return {
    hostId: 'local',
    gpu: { name: 'NVIDIA GeForce RTX 4070', memoryBytes: 12 * GiB, ok: true },
    ramBytes: 32 * GiB,
    ramLow: false,
    baseModel: { bundleId: 'moss-base', name: 'MOSS-Image Base', installed: true, missingBytes: 0 },
    trainer: { versionId: 'trainer-main', state: 'ready' },
    disk: { path: '/fixture/data', freeBytes: 412 * GiB, ok: true },
    blockReason: null,
    ready: true,
    prepare: { running: false, step: null, error: null },
    samplesByDefault: true,
    ...patch,
  }
}

/** 本机 has a usable card, but nothing for training is there yet. */
export function trainingNotPreparedFixture(): TrainingReadiness {
  return trainingReadinessFixture({
    baseModel: { bundleId: 'moss-base', name: 'MOSS-Image Base', installed: false, missingBytes: BASE_BYTES },
    trainer: { versionId: null, state: 'missing' },
    ready: false,
  })
}

/** 本机 has no NVIDIA card. */
export function trainingBlockedFixture(): TrainingReadiness {
  return trainingReadinessFixture({
    gpu: { name: 'AMD Radeon RX 7800 XT', memoryBytes: 16 * GiB, ok: false },
    trainer: { versionId: null, state: 'missing' },
    blockReason: 'no-nvidia',
    ready: false,
  })
}

export function trainingProjectFixture(patch: Partial<TrainingProject> = {}): TrainingProject {
  const kind = patch.kind ?? 'person'
  const trigger = patch.trigger ?? (kind === 'style' ? '' : 'juzi')
  return {
    id: 'tp-juzi',
    name: '橘子',
    kind,
    trigger,
    length: 'standard',
    recipe: presetRecipe(kind, 'standard', { samples: true, trigger }),
    hostId: 'local',
    versionId: null,
    state: 'draft',
    createdAt: NOW,
    updatedAt: NOW,
    jobId: null,
    runName: null,
    startedAt: null,
    finishedAt: null,
    stepReached: 0,
    chosenStep: null,
    adapterId: null,
    saveError: null,
    saveErrorStep: null,
    failure: null,
    cover: null,
    imageCount: 0,
    ...patch,
  }
}

const CAPTIONS = [
  '趴在木地板上晒太阳，侧面',
  '坐在沙发扶手上，看向镜头',
  '在草地上伸懒腰，午后阳光',
  '蜷在毯子上睡觉，俯拍',
  '站在窗边，背光',
]

/**
 * 24 pictures of one subject: two too small (8th, 17th), one the same as the
 * 4th (12th), six without a description.
 */
export function datasetFixture(id: string, trigger = 'juzi', count = 24): DatasetImage[] {
  const noCaption = new Set([4, 9, 13, 18, 20, 22])
  return Array.from({ length: count }, (_, index) => {
    const small = index === 7 || index === 16
    const [width, height] = small ? [384, 288] : index % 3 === 1 ? [1536, 2048] : [1024, 1024]
    const name = `${String(index + 1).padStart(2, '0')}-${width}x${height}.png`
    const duplicate = index === 11
    return {
      name,
      path: `/fixture/training/${id}/pictures/${name}`,
      width,
      height,
      caption: noCaption.has(index) ? null : `${trigger}，${CAPTIONS[index % CAPTIONS.length]}`,
      problems: [...(small ? (['small'] as const) : []), ...(duplicate ? (['duplicate'] as const) : [])],
      ...(duplicate ? { duplicateOf: 4 } : {}),
    }
  })
}

export function datasetOf(images: readonly DatasetImage[]): TrainingDataset {
  return {
    images: [...images],
    counts: {
      total: images.length,
      small: images.filter((image) => image.problems.includes('small')).length,
      duplicate: images.filter((image) => image.problems.includes('duplicate')).length,
      noCaption: images.filter((image) => !image.caption?.trim()).length,
    },
  }
}

/** Sample pictures drawn at `steps` (0 = 训练前), checkpoints at every step after 0. */
export function samplesFixture(id: string, prompts: string[], steps: number[], nextStep: number | null = null): TrainingSamples {
  return {
    prompts,
    columns: steps.map((step) => ({
      step,
      images: prompts.map((_, row) => `/fixture/training/${id}/samples/s${step}-p${row}-512x512.png`),
    })),
    checkpoints: steps.filter((step) => step > 0),
    nextStep,
  }
}

export function trainingJobFixture(project: TrainingProject, patch: Partial<JobRecord> = {}): JobRecord {
  const total = project.recipe.steps
  const step = patch.metrics?.step ?? 1250
  return {
    id: `job-${project.id}`,
    instanceId: 'kohaku-trainer',
    instanceName: 'Kohaku Trainer',
    kind: 'training',
    trainerRunName: project.name,
    hostId: project.hostId,
    mode: 'training',
    state: 'running',
    stage: 'denoise',
    params: { prompt: project.name, negativePrompt: '', width: 1024, height: 1024, steps: total, cfg: 0, seed: 0, profile: 'base' },
    progress: { stage: 'denoise', current: step, total, percent: (step / total) * 100, etaMs: 24 * 60_000 },
    metrics: { step, loss: 0.084 },
    startedAt: NOW,
    ...patch,
  }
}

const steps = (every: number, last: number): number[] => Array.from({ length: Math.floor(last / every) + 1 }, (_, index) => index * every)

/** A list of trainings in every state: running, two done, failed, stopped, a draft. */
export function trainingsFixture(): Pick<MockTrainingState, 'projects' | 'datasets' | 'samples'> & { jobs: JobRecord[] } {
  const ago = (days: number): string => new Date(Date.parse(NOW) - days * 86_400_000).toISOString()
  const running = trainingProjectFixture({
    id: 'tp-juzi',
    state: 'running',
    jobId: 'job-tp-juzi',
    runName: 'juzi-1',
    startedAt: NOW,
    stepReached: 1250,
    imageCount: 22,
    updatedAt: NOW,
    cover: '/fixture/training/tp-juzi/samples/s1250-p0-512x512.png',
  })
  const styleRecipe = presetRecipe('style', 'standard', { samples: true, trigger: '' })
  const watercolor = trainingProjectFixture({
    id: 'tp-watercolor',
    runName: 'watercolor-1',
    name: '水彩小镇',
    kind: 'style',
    trigger: '',
    recipe: styleRecipe,
    state: 'done',
    jobId: 'job-tp-watercolor',
    startedAt: ago(2),
    finishedAt: new Date(Date.parse(ago(2)) + 58 * 60_000).toISOString(),
    updatedAt: ago(2),
    stepReached: 1500,
    chosenStep: 1250,
    adapterId: 'trained-tp-watercolor',
    imageCount: 30,
    cover: '/fixture/training/tp-watercolor/samples/s1250-p0-512x512.png',
  })
  const objectRecipe = presetRecipe('object', 'standard', { samples: true, trigger: 'green_mug' })
  const mug = trainingProjectFixture({
    id: 'tp-green-mug',
    runName: 'green_mug-1',
    name: '绿色马克杯',
    kind: 'object',
    trigger: 'green_mug',
    recipe: objectRecipe,
    state: 'done',
    startedAt: ago(5),
    finishedAt: ago(5),
    updatedAt: ago(5),
    stepReached: 2000,
    chosenStep: 2000,
    adapterId: 'trained-tp-green-mug',
    imageCount: 18,
    cover: '/fixture/training/tp-green-mug/samples/s2000-p0-512x512.png',
  })
  const film = trainingProjectFixture({
    id: 'tp-film',
    runName: 'film-1',
    name: '胶片感',
    kind: 'style',
    trigger: '',
    recipe: styleRecipe,
    state: 'failed',
    startedAt: ago(6),
    finishedAt: ago(6),
    updatedAt: ago(6),
    failure: '显存不够 · 换成 8 GB 档再试',
    imageCount: 40,
  })
  const stopped = trainingProjectFixture({
    id: 'tp-juzi-2',
    runName: 'juzi-2',
    name: '橘子 2',
    state: 'stopped',
    startedAt: ago(8),
    finishedAt: ago(8),
    updatedAt: ago(8),
    stepReached: 500,
    imageCount: 22,
    cover: '/fixture/training/tp-juzi-2/samples/s500-p0-512x512.png',
  })
  const draft = trainingProjectFixture({ id: 'tp-aming', name: '阿明', trigger: 'aming', updatedAt: ago(9), imageCount: 24 })
  return {
    projects: [running, watercolor, mug, film, stopped, draft],
    datasets: {
      'tp-juzi': datasetFixture('tp-juzi').slice(0, 22),
      'tp-aming': datasetFixture('tp-aming', 'aming'),
    },
    samples: {
      'tp-juzi': samplesFixture('tp-juzi', running.recipe.samplePrompts, steps(250, 1250), 1500),
      'tp-watercolor': samplesFixture('tp-watercolor', styleRecipe.samplePrompts, steps(250, 1500)),
      'tp-green-mug': samplesFixture('tp-green-mug', objectRecipe.samplePrompts, steps(500, 2000)),
      'tp-juzi-2': samplesFixture('tp-juzi-2', stopped.recipe.samplePrompts, steps(250, 500)),
    },
    jobs: [trainingJobFixture(running)],
  }
}

export function trainingStateFixture(patch: Partial<MockTrainingState> = {}): MockTrainingState {
  return {
    readiness: trainingReadinessFixture(),
    projects: [],
    datasets: {},
    samples: {},
    captionError: null,
    saveError: null,
    startError: null,
    prepareStepMs: 400,
    startMs: 300,
    nextId: 1,
    ...patch,
  }
}

interface TrainingContext {
  state: { training: MockTrainingState; jobs: JobRecord[]; downloads: DownloadTask[]; catalog: Catalog; hosts: ManagedHost[] }
  emit: (event: string, data: unknown) => void
}

type Handler = (payload: unknown, context: TrainingContext) => unknown

class TrainingMockError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const p = <T>(payload: unknown): T => (payload ?? {}) as T

function find(state: TrainingContext['state'], id: string): TrainingProject {
  const project = state.training.projects.find((item) => item.id === id)
  if (!project) throw new TrainingMockError('E_TRAINING_MISSING', '找不到这个训练，它可能已经被删除。')
  return project
}

function save(context: TrainingContext, project: TrainingProject, emit = false): TrainingProject {
  const training = context.state.training
  training.projects = training.projects.some((item) => item.id === project.id)
    ? training.projects.map((item) => (item.id === project.id ? project : item))
    : [project, ...training.projects]
  if (emit) context.emit(Events.trainingChanged, project)
  return project
}

function readinessFor(context: TrainingContext, hostId: string): TrainingReadiness {
  if (hostId === 'local') return context.state.training.readiness
  const host = context.state.hosts.find((item) => item.id === hostId)
  if (!host) throw new TrainingMockError('E_TRAINING_HOST', '找不到这台训练主机，请在设置里检查主机。')
  return trainingReadinessFixture({ hostId, gpu: { name: host.remote?.gpu ?? 'NVIDIA GeForce RTX 4090', memoryBytes: 24 * GiB, ok: true } })
}

function imagesOf(context: TrainingContext, id: string): DatasetImage[] {
  return context.state.training.datasets[id] ?? []
}

function setImages(context: TrainingContext, id: string, images: DatasetImage[]): TrainingDataset {
  context.state.training.datasets[id] = images
  const project = find(context.state, id)
  save(context, { ...project, imageCount: images.length, updatedAt: new Date().toISOString() })
  return datasetOf(images)
}

/** A picture from a dropped or picked path; a path without an extension is a folder of three. */
function picturesFrom(path: string, existing: number): DatasetImage[] {
  const base = path.split(/[\\/]/).pop() || 'picture'
  if (!/\.[A-Za-z0-9]{2,5}$/.test(base)) {
    return [0, 1, 2].map((index) => {
      const name = `${base}-${existing + index + 1}-1024x1024.png`
      return { name, path: `${path}/${name}`, width: 1024, height: 1024, caption: null, problems: [] }
    })
  }
  const size = /(\d{2,4})x(\d{2,4})/.exec(base)
  const width = size ? Number(size[1]) : 1024
  const height = size ? Number(size[2]) : 1024
  const small = Math.min(width, height) < SMALL_PICTURE_SIDE
  return [{ name: base, path, width, height, caption: null, problems: small ? ['small'] : [] }]
}

function playPrepare(context: TrainingContext): void {
  const training = context.state.training
  const ms = training.prepareStepMs
  const bundle = context.state.catalog.bundles.find((item) => item.id === training.readiness.baseModel.bundleId)
  const ids = bundle ? Object.values(bundle.components) : []
  const missing = context.state.catalog.models.filter((model) => ids.includes(model.id) && !model.installed)
  const update = (patch: Partial<TrainingReadiness>): void => {
    training.readiness = { ...training.readiness, ...patch }
    context.emit(Events.trainingReadinessChanged, training.readiness)
  }
  const download = (fraction: number, state: DownloadTask['state']): void => {
    for (const model of missing) {
      const task: DownloadTask = {
        id: `model:${model.id}`,
        kind: 'model',
        targetId: model.id,
        label: model.name,
        state,
        filesTotal: 1,
        filesDone: state === 'done' ? 1 : 0,
        bytes: Math.round(model.sizeBytes * fraction),
        totalBytes: model.sizeBytes,
        speedBps: state === 'running' ? 38 * 1024 ** 2 : 0,
        updatedAt: new Date().toISOString(),
      }
      context.state.downloads = [...context.state.downloads.filter((item) => item.id !== task.id), task]
      context.emit(Events.download, task)
    }
  }
  const steps: Array<() => void> = [
    () => download(0.43, 'running'),
    () => {
      download(1, 'done')
      context.state.catalog = {
        ...context.state.catalog,
        models: context.state.catalog.models.map((model) =>
          ids.includes(model.id) ? { ...model, installed: true, installState: 'ready', installedBytes: model.sizeBytes } : model,
        ),
      }
      update({
        baseModel: { ...training.readiness.baseModel, installed: true, missingBytes: 0 },
        trainer: { versionId: null, state: 'installing' },
        prepare: { running: true, step: 'trainer', error: null },
      })
    },
    () => update({ prepare: { running: true, step: 'environment', error: null } }),
    () =>
      update({
        trainer: { versionId: 'trainer-main', state: 'ready' },
        ready: true,
        prepare: { running: false, step: null, error: null },
      }),
  ]
  steps.forEach((step, index) => setTimeout(step, ms * (index + 1)))
}

function draftName(kind: TrainingKind, projects: readonly TrainingProject[]): string {
  const base = kind === 'person' ? '新的人物' : kind === 'style' ? '新的画风' : '新的物品'
  let name = base
  for (let n = 2; projects.some((item) => item.name === name); n += 1) name = `${base} ${n}`
  return name
}

const busy = (project: TrainingProject): boolean => project.state === 'starting' || project.state === 'running'

/** As main's assertDatasetEditable: pictures and descriptions change only while no run reads them. */
function assertPicturesEditable(project: TrainingProject): void {
  if (busy(project)) throw new TrainingMockError('E_TRAINING_RUNNING', '训练正在开始或进行，图片和描述先不能改。')
}

/** The LoRA a chosen step is saved as, registered in 模型 like main's `trained-<id>`. */
export function trainedAdapterFixture(id: string, name: string): AdapterEntry {
  const adapterId = `trained-${id}`
  return {
    id: adapterId,
    name,
    provider: 'local',
    repo: `/fixture/data/models/adapters/${adapterId}/${adapterId}.safetensors`,
    revision: 'local',
    kind: 'lora',
    license: 'local',
    files: [`${adapterId}.safetensors`],
    sizeBytes: 151_000_000,
    tags: ['trained'],
    installed: true,
    installedBytes: 151_000_000,
  }
}

/** Starts waiting for `runStarted` (startMs null), by training id. */
const waitingStarts = new Map<string, () => void>()

/** The pictures are ready and the job runs: `starting` becomes `running`, as main reports it. */
export function runStarted(context: TrainingContext, id: string): void {
  const project = context.state.training.projects.find((item) => item.id === id)
  if (project?.state !== 'starting') return
  waitingStarts.get(id)?.()
  waitingStarts.delete(id)
  const now = new Date().toISOString()
  const running: TrainingProject = {
    ...project,
    state: 'running',
    jobId: `job-${project.id}`,
    runName: `${project.trigger || 'run'}-1`,
    updatedAt: now,
    stepReached: 10,
  }
  const job = trainingJobFixture(running, {
    startedAt: now,
    metrics: { step: 10, loss: 0.21 },
    progress: { stage: 'denoise', current: 10, total: running.recipe.steps, percent: 0.3, etaMs: 50 * 60_000 },
  })
  context.state.jobs = [job, ...context.state.jobs.filter((item) => item.id !== job.id)]
  context.emit(Events.job, job)
  context.state.training.samples[project.id] = samplesFixture(
    project.id,
    project.recipe.samplePrompts,
    [0],
    project.recipe.sampleEvery || null,
  )
  save(context, running, true)
}

const handlers: Array<[string, Handler]> = [
  [Ipc.trainingReadiness, (payload, context) => readinessFor(context, p<{ hostId: string }>(payload).hostId)],
  [
    Ipc.trainingPrepare,
    (payload, context) => {
      const { hostId } = p<{ hostId: string }>(payload)
      const readiness = readinessFor(context, hostId)
      if (hostId !== 'local' || readiness.blockReason || readiness.ready || readiness.prepare.running) return readiness
      context.state.training.readiness = { ...readiness, prepare: { running: true, step: 'model', error: null } }
      context.emit(Events.trainingReadinessChanged, context.state.training.readiness)
      playPrepare(context)
      return context.state.training.readiness
    },
  ],
  [Ipc.trainingList, (_, { state }) => [...state.training.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))],
  [
    Ipc.trainingCreate,
    (payload, context) => {
      const { kind, hostId = 'local' } = p<{ kind: TrainingKind; hostId?: string }>(payload)
      const training = context.state.training
      const name = draftName(kind, training.projects)
      const trigger = kind === 'style' ? '' : triggerFrom(name, kind === 'object' ? 'my_object' : 'my_person')
      const now = new Date().toISOString()
      const project = trainingProjectFixture({
        id: `tp-new-${training.nextId++}`,
        name,
        kind,
        trigger,
        hostId,
        recipe: presetRecipe(kind, 'standard', { samples: readinessFor(context, hostId).samplesByDefault, trigger }),
        createdAt: now,
        updatedAt: now,
      })
      training.datasets[project.id] = []
      return save(context, project)
    },
  ],
  [Ipc.trainingGet, (payload, { state }) => find(state, p<{ id: string }>(payload).id)],
  [
    Ipc.trainingUpdate,
    (payload, context) => {
      const { id, patch } = p<{ id: string; patch: Partial<TrainingProject> }>(payload)
      const project = find(context.state, id)
      if (busy(project)) throw new TrainingMockError('E_TRAINING_RUNNING', '训练正在开始或进行，设置先不能改。')
      if (project.state !== 'draft')
        throw new TrainingMockError('E_TRAINING_NOT_DRAFT', '这个训练已经开始过，设置不能再改。可以复制一份再改。')
      return save(context, { ...project, ...patch, updatedAt: new Date().toISOString() })
    },
  ],
  [
    Ipc.trainingRemove,
    (payload, { state }) => {
      const { id } = p<{ id: string }>(payload)
      if (busy(find(state, id))) throw new TrainingMockError('E_TRAINING_RUNNING', '训练正在开始或进行。等它开始后先停止，再删除。')
      state.training.projects = state.training.projects.filter((item) => item.id !== id)
      delete state.training.datasets[id]
      delete state.training.samples[id]
      return null
    },
  ],
  [
    Ipc.trainingDuplicate,
    (payload, context) => {
      const source = find(context.state, p<{ id: string }>(payload).id)
      const training = context.state.training
      const now = new Date().toISOString()
      const copy = trainingProjectFixture({
        ...source,
        id: `tp-new-${training.nextId++}`,
        name: `${source.name} 2`,
        state: 'draft',
        createdAt: now,
        updatedAt: now,
        jobId: null,
        runName: null,
        startedAt: null,
        finishedAt: null,
        stepReached: 0,
        chosenStep: null,
        adapterId: null,
        saveError: null,
        failure: null,
        cover: null,
      })
      training.datasets[copy.id] = imagesOf(context, source.id).map((image) => ({ ...image }))
      return save(context, { ...copy, imageCount: training.datasets[copy.id]!.length })
    },
  ],
  [Ipc.trainingDataset, (payload, context) => datasetOf(imagesOf(context, find(context.state, p<{ id: string }>(payload).id).id))],
  [
    Ipc.trainingDatasetAdd,
    (payload, context) => {
      const { id, paths } = p<{ id: string; paths: string[] }>(payload)
      assertPicturesEditable(find(context.state, id))
      const images = [...imagesOf(context, id)]
      for (const path of paths) {
        for (const image of picturesFrom(path, images.length)) if (!images.some((item) => item.name === image.name)) images.push(image)
      }
      return setImages(context, id, images)
    },
  ],
  [
    Ipc.trainingDatasetRemove,
    (payload, context) => {
      const { id, names } = p<{ id: string; names: string[] }>(payload)
      assertPicturesEditable(find(context.state, id))
      return setImages(
        context,
        id,
        imagesOf(context, id).filter((image) => !names.includes(image.name)),
      )
    },
  ],
  [
    Ipc.trainingCaptionSet,
    (payload, context) => {
      const { id, name, caption } = p<{ id: string; name: string; caption: string }>(payload)
      assertPicturesEditable(find(context.state, id))
      const image = imagesOf(context, id).find((item) => item.name === name)
      if (!image) throw new TrainingMockError('E_TRAINING_PICTURE', '这张图片已经不在了，请刷新后再试。')
      const next = { ...image, caption: caption.trim() ? caption : null }
      context.state.training.datasets[id] = imagesOf(context, id).map((item) => (item.name === name ? next : item))
      return next
    },
  ],
  [
    Ipc.trainingCaptionAuto,
    (payload, context): TrainingCaptionResult => {
      const { id } = p<{ id: string }>(payload)
      const project = find(context.state, id)
      assertPicturesEditable(project)
      const error = context.state.training.captionError
      if (error) return { written: 0, failed: 0, error }
      let written = 0
      context.state.training.datasets[id] = imagesOf(context, id).map((image) => {
        if (image.caption?.trim()) return image
        written += 1
        return { ...image, caption: [project.trigger, '一张照片'].filter(Boolean).join('，') }
      })
      return { written, failed: 0, error: null }
    },
  ],
  [
    Ipc.trainingCommand,
    (payload, { state }) => {
      const project = find(state, p<{ id: string }>(payload).id)
      return `python -m kohaku_trainer train --algo ${project.recipe.algo} --steps ${project.recipe.steps} --resolution ${project.recipe.resolution}`
    },
  ],
  [
    Ipc.trainingStart,
    async (payload, context) => {
      const project = find(context.state, p<{ id: string }>(payload).id)
      const training = context.state.training
      if (busy(project)) throw new TrainingMockError('E_TRAINING_RUNNING', '这个训练已经在开始或进行了。')
      if (project.state === 'done') throw new TrainingMockError('E_TRAINING_DONE', '这个训练已经完成。想再练一次，可以复制一份。')
      // As main: `starting` first (pictures prepared or uploaded); the call answers once the job runs, or the training is a draft again.
      save(context, { ...project, state: 'starting', updatedAt: new Date().toISOString() }, true)
      const back = (code: string, message: string): never => {
        save(context, { ...find(context.state, project.id), state: 'draft' }, true)
        throw new TrainingMockError(code, message)
      }
      if (!imagesOf(context, project.id).length) back('E_TRAINING_EMPTY', '先添加至少一张图片。')
      await new Promise<void>((resolve) => {
        if (training.startMs === null) waitingStarts.set(project.id, resolve)
        else setTimeout(resolve, training.startMs)
      })
      if (training.startError) back('E_TRAINING_UPLOAD', training.startError)
      runStarted(context, project.id)
      return find(context.state, project.id)
    },
  ],
  [
    Ipc.trainingStop,
    (payload, context) => {
      const project = find(context.state, p<{ id: string }>(payload).id)
      const job = context.state.jobs.find((item) => item.id === project.jobId)
      if (job) {
        const stopped: JobRecord = { ...job, state: 'canceled', endedAt: new Date().toISOString() }
        context.state.jobs = context.state.jobs.map((item) => (item.id === job.id ? stopped : item))
        context.emit(Events.job, stopped)
      }
      save(context, { ...project, state: 'stopped', finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, true)
      return null
    },
  ],
  [
    Ipc.trainingSamples,
    (payload, { state }) => {
      const project = find(state, p<{ id: string }>(payload).id)
      return state.training.samples[project.id] ?? { prompts: project.recipe.samplePrompts, columns: [], checkpoints: [], nextStep: null }
    },
  ],
  [
    Ipc.trainingChooseStep,
    (payload, context) => {
      const { id, step } = p<{ id: string; step: number }>(payload)
      const project = find(context.state, id)
      if (busy(project)) throw new TrainingMockError('E_TRAINING_RUNNING', '训练还在进行。等它结束或停止后再选。')
      if (!project.runName) throw new TrainingMockError('E_TRAINING_NO_RUN', '这个训练还没有结果。')
      const samples = context.state.training.samples[id] ?? { prompts: [], columns: [], checkpoints: [], nextStep: null }
      // As main: a failed save keeps the step (and LoRA) saved before, and says which step failed.
      const saveError = samples.checkpoints.includes(step)
        ? context.state.training.saveError
        : `没有找到第 ${step} 步保存的 LoRA。换一步试试。`
      if (saveError) return save(context, { ...project, saveError, saveErrorStep: step, updatedAt: new Date().toISOString() })
      const adapter = trainedAdapterFixture(id, project.name)
      if (!context.state.catalog.adapters.some((item) => item.id === adapter.id))
        context.state.catalog = { ...context.state.catalog, adapters: [...context.state.catalog.adapters, adapter] }
      const adapterId = adapter.id
      const cover = samples.columns.find((column) => column.step === step)?.images[0] ?? project.cover
      return save(context, {
        ...project,
        chosenStep: step,
        adapterId,
        saveError: null,
        saveErrorStep: null,
        cover,
        updatedAt: new Date().toISOString(),
      })
    },
  ],
  [
    Ipc.trainingReveal,
    (payload, { state }) => {
      find(state, p<{ id: string }>(payload).id)
      return null
    },
  ],
]

/** Register the 训练 handlers; `toIpcError` turns a coded failure into the backend's MockIpcError. */
export function addTrainingHandlers(
  register: (channel: string, handler: (payload: unknown, context: TrainingContext) => unknown) => void,
  toIpcError: (code: string, message: string) => Error,
): void {
  for (const [channel, handler] of handlers) {
    register(channel, async (payload, context) => {
      try {
        return await handler(payload, context)
      } catch (error) {
        if (error instanceof TrainingMockError) throw toIpcError(error.code, error.message)
        throw error
      }
    })
  }
}
