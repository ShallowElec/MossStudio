/**
 * 训练 projects on disk: `<data root>/training/<id>/project.json`, with the pictures in `images/`
 * beside it. Writes go through one queue per project, so a run finishing while the person edits
 * never loses either change.
 */
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  defaultSamplePrompts,
  lengthOf,
  presetRecipe,
  triggerFrom,
  type TrainingKind,
  type TrainingLength,
  type TrainingProject,
  type TrainingRecipe,
} from '@shared/training'
import { codedError } from '../../lib/codedError'
import { writeFileAtomic } from '../../lib/atomicWrite'
import { paths } from '../../lib/paths'

export const TRAINING_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])

const DEFAULT_NAMES: Record<TrainingKind, string> = { person: '新的人物', style: '新的画风', object: '新的物品' }
const TRIGGER_FALLBACK = 'subj'

export function projectDir(id: string): string {
  return paths.trainingProject(id)
}

export function imagesDir(id: string): string {
  return join(projectDir(id), 'images')
}

function projectFile(id: string): string {
  return join(projectDir(id), 'project.json')
}

/** `tp-` + time + random, inside the id pattern of `trainingSchemas`. */
export function newTrainingId(): string {
  return `tp-${Date.now().toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 6)}`
}

export function triggerFor(kind: TrainingKind, name: string): string {
  return kind === 'style' ? '' : triggerFrom(name, TRIGGER_FALLBACK)
}

function isImageName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot > 0 && TRAINING_IMAGE_EXT.has(name.slice(dot).toLowerCase())
}

async function imageCount(id: string): Promise<number> {
  try {
    return (await readdir(imagesDir(id))).filter(isImageName).length
  } catch {
    return 0
  }
}

async function readProject(id: string): Promise<TrainingProject | null> {
  try {
    const project = JSON.parse(await readFile(projectFile(id), 'utf8')) as TrainingProject
    // Written before saveErrorStep existed.
    return project.id === id ? { ...project, saveErrorStep: project.saveErrorStep ?? null, imageCount: await imageCount(id) } : null
  } catch {
    return null
  }
}

/** A queue per key: each task starts after the key's earlier tasks have finished, failed or not. */
export function keyedQueue(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const queues = new Map<string, Promise<unknown>>()
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    const settled = next.catch(() => undefined)
    queues.set(key, settled)
    void settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key)
    })
    return next
  }
}

/** One queue for everything that writes a project: its project.json, pictures and descriptions. */
const serial = keyedQueue()

/** A run is being started or is going: settings, pictures and descriptions stay as they are. */
export function isBusy(project: Pick<TrainingProject, 'state'>): boolean {
  return project.state === 'starting' || project.state === 'running'
}

async function writeProject(project: TrainingProject): Promise<void> {
  await mkdir(projectDir(project.id), { recursive: true })
  await writeFileAtomic(projectFile(project.id), JSON.stringify(project, null, 2))
}

export async function getTrainingProject(id: string): Promise<TrainingProject> {
  const project = await readProject(id)
  if (!project) throw codedError('E_TRAINING_MISSING', '找不到这个训练，它可能已经被删除。')
  return project
}

const NOT_EDITABLE = '训练正在开始或进行，图片和描述先不能改。'

/** Pictures and descriptions change only while no run reads them. */
export async function assertDatasetEditable(id: string): Promise<void> {
  if (isBusy(await getTrainingProject(id))) throw codedError('E_TRAINING_RUNNING', NOT_EDITABLE)
}

/**
 * Runs a change to the pictures or descriptions in the project's write queue, after checking
 * that no run is starting: a start marks the training `starting` through the same queue, so a
 * change either lands before it or is refused.
 */
export function whileEditable<T>(id: string, task: () => Promise<T>): Promise<T> {
  return serial(id, async () => {
    await assertDatasetEditable(id)
    return task()
  })
}

export async function listTrainingProjects(): Promise<TrainingProject[]> {
  let names: string[]
  try {
    names = await readdir(paths.training())
  } catch {
    return []
  }
  const projects = await Promise.all(names.filter((name) => name.startsWith('tp-')).map(readProject))
  return projects.filter((item): item is TrainingProject => Boolean(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Read, change and write one project, after its earlier writes; the change returns the new project. */
export function mutateTrainingProject(
  id: string,
  change: (project: TrainingProject) => TrainingProject | Promise<TrainingProject>,
): Promise<TrainingProject> {
  return serial(id, async () => {
    const current = await getTrainingProject(id)
    const next = await change(current)
    const saved = { ...next, updatedAt: new Date().toISOString() }
    await writeProject(saved)
    return { ...saved, imageCount: await imageCount(id) }
  })
}

export async function createTrainingProject(input: { kind: TrainingKind; hostId?: string; samples: boolean }): Promise<TrainingProject> {
  const now = new Date().toISOString()
  const name = DEFAULT_NAMES[input.kind]
  const trigger = triggerFor(input.kind, name)
  const project: TrainingProject = {
    id: newTrainingId(),
    name,
    kind: input.kind,
    trigger,
    length: 'standard',
    recipe: presetRecipe(input.kind, 'standard', { samples: input.samples, trigger }),
    hostId: input.hostId ?? 'local',
    versionId: null,
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
    saveErrorStep: null,
    failure: null,
    cover: null,
    imageCount: 0,
  }
  await mkdir(imagesDir(project.id), { recursive: true })
  await writeProject(project)
  return project
}

export interface TrainingPatch {
  name?: string
  kind?: TrainingKind
  trigger?: string
  length?: TrainingLength
  recipe?: TrainingRecipe
  hostId?: string
  versionId?: string | null
}

function samePrompts(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * The settings after a patch. A new 学什么 or 训练多久 (other than 自定义) brings that preset's
 * recipe, keeping whether samples are drawn and how often; the sample prompts follow the kind and
 * trigger for as long as they are still the defaults (the person did not write their own).
 */
export function applyTrainingPatch(project: TrainingProject, patch: TrainingPatch): TrainingProject {
  const kind = patch.kind ?? project.kind
  const kindChanged = kind !== project.kind
  let trigger = patch.trigger?.trim() ?? project.trigger
  if (patch.trigger === undefined && kindChanged) {
    trigger = kind === 'style' ? '' : project.trigger || triggerFor(kind, patch.name ?? project.name)
  }
  const defaultPrompts = samePrompts(project.recipe.samplePrompts, defaultSamplePrompts(project.kind, project.trigger))
  let recipe = patch.recipe ?? project.recipe
  let length: TrainingLength = patch.length ?? (patch.recipe ? lengthOf(kind, patch.recipe, trigger) : project.length)
  const lengthChanged = length !== project.length
  if (length !== 'custom' && (kindChanged || lengthChanged)) {
    const preset = presetRecipe(kind, length, { samples: recipe.sampleEvery > 0, trigger })
    recipe = { ...preset, sampleEvery: recipe.sampleEvery, samplePrompts: recipe.samplePrompts }
  }
  if (defaultPrompts && !(patch.recipe && !samePrompts(patch.recipe.samplePrompts, project.recipe.samplePrompts))) {
    recipe = { ...recipe, samplePrompts: defaultSamplePrompts(kind, trigger) }
  }
  if (patch.recipe && !patch.length) length = lengthOf(kind, recipe, trigger)
  return {
    ...project,
    name: patch.name?.trim() || project.name,
    kind,
    trigger,
    length,
    recipe,
    hostId: patch.hostId ?? project.hostId,
    versionId: patch.versionId === undefined ? project.versionId : patch.versionId,
  }
}

export function updateTrainingProject(id: string, patch: TrainingPatch): Promise<TrainingProject> {
  return mutateTrainingProject(id, (project) => {
    if (isBusy(project)) throw codedError('E_TRAINING_RUNNING', '训练正在开始或进行，设置先不能改。')
    if (project.state !== 'draft') {
      throw codedError('E_TRAINING_NOT_DRAFT', '这个训练已经开始过，设置不能再改。可以复制一份再改。')
    }
    return applyTrainingPatch(project, patch)
  })
}

export async function removeTrainingProject(id: string): Promise<void> {
  await serial(id, async () => {
    const project = await readProject(id)
    if (project && isBusy(project)) throw codedError('E_TRAINING_RUNNING', '训练正在开始或进行。等它开始后先停止，再删除。')
    await rm(projectDir(id), { recursive: true, force: true, maxRetries: 3 })
  })
}

/** A new draft with the same pictures, descriptions and settings. */
export async function duplicateTrainingProject(id: string): Promise<TrainingProject> {
  const source = await getTrainingProject(id)
  const now = new Date().toISOString()
  const copy: TrainingProject = {
    ...source,
    id: newTrainingId(),
    name: `${source.name} 2`.slice(0, 60),
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
    saveErrorStep: null,
    failure: null,
    cover: null,
  }
  await mkdir(imagesDir(copy.id), { recursive: true })
  try {
    for (const name of await readdir(imagesDir(id))) {
      if (isImageName(name) || name.toLowerCase().endsWith('.txt'))
        await copyFile(join(imagesDir(id), name), join(imagesDir(copy.id), name))
    }
    await writeProject(copy)
  } catch (error) {
    await rm(projectDir(copy.id), { recursive: true, force: true })
    throw error
  }
  return { ...copy, imageCount: await imageCount(copy.id) }
}
