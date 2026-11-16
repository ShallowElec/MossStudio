/**
 * What a run left behind, read from its folder (KohakuMossTrainer's layout under OUTPUT_DIR/RUN_NAME):
 * `samples/step_XXXXXXXX/NNN.png` (one picture per sample prompt, in prompt order, `settings.json`
 * written last), `checkpoints/step_XXXXXXXX/export/<run>-comfy.safetensors` and, at the end of a
 * finished run, `export/<run>-comfy.safetensors`. A remote run's sample folders are copied into the
 * same local layout; which checkpoints it has is kept in `remote.json`.
 */
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TrainingProject, TrainingSampleColumn, TrainingSamples } from '@shared/training'
import type { TrainingHost } from '@shared/types'
import { writeFileAtomic } from '../../lib/atomicWrite'
import { posixQuote, scpFrom, sshExec } from '../ssh'
import { projectDir } from './store'

const STEP_DIR = /^step_(\d+)$/
const SAMPLE_FILE = /^\d{3}\.png$/
const LIST_TIMEOUT_MS = 20_000
const COPY_TIMEOUT_MS = 120_000

export function stepFolder(step: number): string {
  return `step_${String(step).padStart(8, '0')}`
}

export function exportFileName(runName: string): string {
  return `${runName}-comfy.safetensors`
}

/** The run's local folder: its outputs (local) or the copied samples (remote). */
export function localRunDir(project: Pick<TrainingProject, 'id' | 'runName'>): string {
  return join(projectDir(project.id), 'runs', project.runName ?? '')
}

/** Where step `step`'s LoRA can be, best first, relative to the run folder (with `/`). */
export function exportCandidates(runName: string, step: number, finalStep: number): string[] {
  const file = exportFileName(runName)
  return [`checkpoints/${stepFolder(step)}/export/${file}`, ...(step === finalStep ? [`export/${file}`] : [])]
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function stepsIn(dir: string): Promise<number[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && STEP_DIR.test(entry.name))
      .map((entry) => Number.parseInt(STEP_DIR.exec(entry.name)![1]!, 10))
      .sort((a, b) => a - b)
  } catch {
    return []
  }
}

async function sampleColumns(runDir: string): Promise<TrainingSampleColumn[]> {
  const columns: TrainingSampleColumn[] = []
  for (const step of await stepsIn(join(runDir, 'samples'))) {
    const folder = join(runDir, 'samples', stepFolder(step))
    const images = (await readdir(folder).catch(() => [] as string[]))
      .filter((name) => SAMPLE_FILE.test(name))
      .sort()
      .map((name) => join(folder, name))
    if (images.length) columns.push({ step, images })
  }
  return columns
}

interface RemoteRunRecord {
  checkpoints: number[]
}

async function readRemoteRecord(runDir: string): Promise<RemoteRunRecord> {
  try {
    const raw = JSON.parse(await readFile(join(runDir, 'remote.json'), 'utf8')) as Partial<RemoteRunRecord>
    return { checkpoints: Array.isArray(raw.checkpoints) ? raw.checkpoints.filter((step) => Number.isInteger(step)) : [] }
  } catch {
    return { checkpoints: [] }
  }
}

/** Steps whose LoRA can be saved; the last step counts when the finished run's own export is there. */
export async function checkpointSteps(project: TrainingProject): Promise<number[]> {
  if (!project.runName) return []
  const runDir = localRunDir(project)
  if (project.hostId !== 'local') return (await readRemoteRecord(runDir)).checkpoints
  const steps: number[] = []
  for (const step of await stepsIn(join(runDir, 'checkpoints'))) {
    if (await exists(join(runDir, 'checkpoints', stepFolder(step), 'export', exportFileName(project.runName)))) steps.push(step)
  }
  const final = project.recipe.steps
  if (!steps.includes(final) && (await exists(join(runDir, 'export', exportFileName(project.runName))))) steps.push(final)
  return steps.sort((a, b) => a - b)
}

/** The next step that gets samples while a run is going, or null. */
export function nextSampleStep(project: TrainingProject, reached: number, lastSampled: number | null): number | null {
  const every = project.recipe.sampleEvery
  if (project.state !== 'running' || every <= 0) return null
  const next = (Math.floor(Math.max(reached, lastSampled ?? -1) / every) + 1) * every
  return next <= project.recipe.steps ? next : null
}

export async function listSamples(project: TrainingProject, reached: number): Promise<TrainingSamples> {
  const prompts = project.recipe.samplePrompts
  if (!project.runName) return { prompts, columns: [], checkpoints: [], nextStep: null }
  const columns = await sampleColumns(localRunDir(project))
  return {
    prompts,
    columns,
    checkpoints: await checkpointSteps(project),
    nextStep: nextSampleStep(project, reached, columns.at(-1)?.step ?? null),
  }
}

/** The card's picture: the chosen step's first sample, else the newest step's. */
export async function coverOf(project: TrainingProject): Promise<string | null> {
  if (!project.runName) return null
  const columns = await sampleColumns(localRunDir(project))
  const chosen = project.chosenStep === null ? undefined : columns.find((column) => column.step === project.chosenStep)
  return (chosen ?? columns.at(-1))?.images[0] ?? null
}

const syncing = new Map<string, Promise<void>>()

/**
 * Copies the remote run's finished sample folders that are not here yet and records its
 * checkpoints. One sync per training at a time; a second call waits for the one running.
 */
export function syncRemoteRun(project: TrainingProject, host: TrainingHost, remoteRunDir: string): Promise<void> {
  const pending = syncing.get(project.id)
  if (pending) return pending
  const task = syncOnce(project, host, remoteRunDir).finally(() => syncing.delete(project.id))
  syncing.set(project.id, task)
  return task
}

async function syncOnce(project: TrainingProject, host: TrainingHost, remoteRunDir: string): Promise<void> {
  if (!project.runName) return
  const file = exportFileName(project.runName)
  const listing = await sshExec(
    host,
    [
      `cd ${posixQuote(remoteRunDir)} 2>/dev/null || exit 0`,
      'for d in samples/step_*; do [ -f "$d/settings.json" ] && echo "S ${d#samples/}"; done',
      `for d in checkpoints/step_*; do [ -f "$d/export/${file}" ] && echo "C \${d#checkpoints/}"; done`,
      `[ -f export/${file} ] && echo F`,
      'true',
    ].join('\n'),
    LIST_TIMEOUT_MS,
  )
  if (listing.code !== 0) throw new Error((listing.stderr || listing.stdout).trim().slice(-400) || 'listing failed')
  const lines = listing.stdout.split('\n').map((line) => line.trim())
  const steps = (prefix: string): number[] =>
    lines
      .filter((line) => line.startsWith(`${prefix} `))
      .map((line) => STEP_DIR.exec(line.slice(2))?.[1])
      .filter((value): value is string => Boolean(value))
      .map((value) => Number.parseInt(value, 10))
  const checkpoints = steps('C')
  if (lines.includes('F') && !checkpoints.includes(project.recipe.steps)) checkpoints.push(project.recipe.steps)
  const runDir = localRunDir(project)
  await mkdir(join(runDir, 'samples'), { recursive: true })
  await writeFileAtomic(join(runDir, 'remote.json'), JSON.stringify({ checkpoints: checkpoints.sort((a, b) => a - b) }))
  for (const step of steps('S')) {
    const target = join(runDir, 'samples', stepFolder(step))
    if (await exists(join(target, 'settings.json'))) continue
    // Copied beside, then renamed, so a half-copied folder is never listed.
    const partial = `${target}.part`
    await rm(partial, { recursive: true, force: true })
    const copied = await scpFrom(host, `${remoteRunDir}/samples/${stepFolder(step)}`, partial, COPY_TIMEOUT_MS, true)
    if (copied.code !== 0) {
      await rm(partial, { recursive: true, force: true })
      throw new Error((copied.stderr || copied.stdout).trim().slice(-400) || `copy of ${stepFolder(step)} failed`)
    }
    await rm(target, { recursive: true, force: true })
    await rename(partial, target)
  }
}
