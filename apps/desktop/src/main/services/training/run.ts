/**
 * A training's run: start it as one job (configs, caches, train), follow it to its end, and save
 * the step the person picks as the LoRA (`trained-<training id>`, replaced when another step is
 * picked). Every failure to save is written to the training as `saveError`, never dropped.
 */
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Events } from '@shared/channels'
import type { TrainingKind, TrainingProject, TrainingSamples } from '@shared/training'
import type { JobRecord, Settings, TrainerVersion, TrainingHost } from '@shared/types'
import { codedError } from '../../lib/codedError'
import { emit } from '../../lib/events'
import { revealInFileManager } from '../../lib/fileManager'
import { pushLocalNotification } from '../desktopNotifications'
import { registerTrainedAdapter, resolveAdapterFile } from '../models'
import { getSettings } from '../settings'
import { posixQuote, scpFrom, scpTo, sshArgs, sshCommand, sshEnv, sshExec, sshWriteFile } from '../ssh'
import { cancelJob, getJob, getJobLogs, listJobs, startTrainingJob } from '../supervisor'
import { listTrainerVersions, trainerRuntimeSummary } from '../trainers'
import { remoteSetup, remoteVersions, rootExpression } from '../remoteTrainer'
import { getTrainingHost } from '../trainingHosts'
import { trainingScript, type TrainingCommandPlan } from './commands'
import { scanDataset, stageDataset, stagedDir } from './dataset'
import { GENERIC_FAILURE, trainingFailureReason } from './failure'
import { installedBaseBundle, localTrainingGpu, samplesByDefault, trainingReadiness } from './readiness'
import { checkpointSteps, coverOf, exportCandidates, exportFileName, listSamples, localRunDir, stepFolder, syncRemoteRun } from './samples'
import {
  createTrainingProject,
  duplicateTrainingProject,
  getTrainingProject,
  isBusy,
  keyedQueue,
  listTrainingProjects,
  mutateTrainingProject,
  projectDir,
  removeTrainingProject,
  updateTrainingProject,
  type TrainingPatch,
} from './store'
import { localWeightsFolder, plannedWeightsFolder } from './weights'

const REMOTE_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 30 * 60_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const INTERRUPTED = '训练被打断了：应用关闭时它还在进行。可以重新开始。'
const START_INTERRUPTED = '训练没能开始：应用在准备时关闭了。可以重新开始。'

/** Trainings this process is starting, with the trainer version once it is known. */
const startingHere = new Map<string, string | null>()
/** One save of a training's LoRA at a time: they share the adapter and the download folder. */
const saves = keyedQueue()

function jobLive(job: JobRecord): boolean {
  return job.state === 'running' || job.state === 'starting' || job.state === 'queued'
}

/** The training as the renderer sees it: the live step of a running job and the card's picture. */
async function present(project: TrainingProject): Promise<TrainingProject> {
  let stepReached = project.stepReached
  if (project.state === 'running' && project.jobId) stepReached = (await getJob(project.jobId))?.progress.current ?? stepReached
  return { ...project, stepReached, cover: await coverOf(project) }
}

async function changed(project: TrainingProject): Promise<TrainingProject> {
  const shown = await present(project)
  emit(Events.trainingChanged, shown)
  return shown
}

function warn(context: string, error: unknown): void {
  console.warn('[training]', `${context}:`, error instanceof Error ? error.message : error)
}

/**
 * A training left `starting` or `running` by something that is no longer there: a start this
 * process is not making (the app closed during it), or a job that ended while nothing listened.
 * A remote run's end needs the host (samples, the stop command), so the list does not wait for it.
 */
async function settle(project: TrainingProject): Promise<void> {
  if (project.state === 'starting') {
    if (startingHere.has(project.id)) return
    const failed = await mutateTrainingProject(project.id, (current) =>
      current.state === 'starting' && !startingHere.has(current.id)
        ? { ...current, state: 'failed', failure: START_INTERRUPTED, finishedAt: new Date().toISOString() }
        : current,
    )
    if (failed.state === 'failed') await changed(failed)
    return
  }
  if (project.state !== 'running') return
  const job = project.jobId ? await getJob(project.jobId) : null
  if (job && jobLive(job)) return
  if (!job) {
    const failed = await finishAs(project.id, project.jobId, { state: 'failed', failure: INTERRUPTED })
    if (failed) await changed(failed)
    return
  }
  if (project.hostId === 'local') await onTrainingJobEnded(job)
  else void onTrainingJobEnded(job).catch((error: unknown) => warn(`settling ${project.id}`, error))
}

export async function trainingList(): Promise<TrainingProject[]> {
  for (const project of await listTrainingProjects()) if (isBusy(project)) await settle(project)
  return Promise.all((await listTrainingProjects()).map(present))
}

export async function trainingGet(id: string): Promise<TrainingProject> {
  const project = await getTrainingProject(id)
  if (isBusy(project)) await settle(project)
  return present(await getTrainingProject(id))
}

export async function trainingCreate(kind: TrainingKind, hostId = 'local'): Promise<TrainingProject> {
  return present(await createTrainingProject({ kind, hostId, samples: await samplesByDefault(getSettings(), hostId) }))
}

export async function trainingUpdate(id: string, patch: TrainingPatch): Promise<TrainingProject> {
  return present(await updateTrainingProject(id, patch))
}

export async function trainingDuplicate(id: string): Promise<TrainingProject> {
  return present(await duplicateTrainingProject(id))
}

/** Deletes the training here and, best effort, its pictures and run on the host; a saved LoRA stays. */
export async function trainingRemove(id: string): Promise<void> {
  const project = await getTrainingProject(id)
  await removeTrainingProject(id)
  if (project.hostId === 'local') return
  try {
    const host = sshHost(getSettings(), project.hostId)
    await sshExec(host, `rm -rf ${posixQuote(remoteTrainingDir(await remoteRoot(host), id))}`, REMOTE_TIMEOUT_MS)
  } catch (error) {
    warn(`remote files of ${id} stay`, error)
  }
}

/** Whether a training is starting or running on this trainer version, so it must not be removed. */
export async function trainerVersionInUse(versionId: string): Promise<boolean> {
  if ([...startingHere.values()].includes(versionId)) return true
  return (await listJobs()).some((job) => job.kind === 'training' && job.trainerVersionId === versionId && jobLive(job))
}

function sshHost(settings: Settings, hostId: string): TrainingHost {
  const host = getTrainingHost(settings, hostId)
  if (!host || host.kind !== 'ssh') throw codedError('E_TRAINING_HOST', '找不到这台训练主机，请在设置里检查主机。')
  return host
}

const remoteRoots = new Map<string, string>()

/** The host's trainer root as an absolute path (scp and the trainer's knobs need one). */
async function remoteRoot(host: TrainingHost): Promise<string> {
  const key = `${host.id}:${host.trainerRoot}`
  const known = remoteRoots.get(key)
  if (known) return known
  const result = await sshExec(host, [remoteSetup(host), 'cd "$ROOT" && pwd -P'].join('\n'), REMOTE_TIMEOUT_MS)
  const root = result.stdout.trim().split('\n').pop() ?? ''
  if (result.code !== 0 || !root.startsWith('/'))
    throw codedError('E_TRAINING_HOST', `连不上训练主机「${host.name}」。请检查网络和主机设置。`)
  remoteRoots.set(key, root)
  return root
}

async function remoteWeights(host: TrainingHost): Promise<string> {
  if (!host.weightsPath) throw codedError('E_TRAINING_WEIGHTS', '先在主机设置里填写 MOSS-Image Base 模型所在的文件夹。')
  const result = await sshExec(host, `cd ${rootExpression(host.weightsPath)} && pwd -P`, REMOTE_TIMEOUT_MS)
  const path = result.stdout.trim().split('\n').pop() ?? ''
  if (result.code !== 0 || !path.startsWith('/')) throw codedError('E_TRAINING_WEIGHTS', '在主机上找不到填写的模型文件夹，请检查主机设置。')
  return path
}

function remoteTrainingDir(root: string, id: string): string {
  return `${root}/training/${id}`
}

/** Ends the run whose pid the script wrote, with its whole process group (its own session). */
export function remoteStopCommand(pidFile: string): string {
  return `P="$(cat ${posixQuote(pidFile)} 2>/dev/null)" && [ -n "$P" ] && { kill -TERM -- "-$P" 2>/dev/null || kill -TERM "$P" 2>/dev/null; }; true`
}

/**
 * Whether a trainer started by this app still runs on the host, for any training: a run whose
 * SSH session dropped keeps going in its own session. A pid only counts while it is still a run.sh.
 */
export function remoteBusyCommand(root: string): string {
  return [
    `for f in ${posixQuote(root)}/training/*/run.pid; do`,
    '  [ -f "$f" ] || continue',
    '  P="$(cat "$f" 2>/dev/null)"',
    '  [ -n "$P" ] && kill -0 "$P" 2>/dev/null && ps -p "$P" -o args= 2>/dev/null | grep -q "run\\.sh" && { echo busy; exit 0; }',
    'done',
    'true',
  ].join('\n')
}

async function stopRemoteRun(project: TrainingProject): Promise<void> {
  try {
    const host = sshHost(getSettings(), project.hostId)
    await sshExec(host, remoteStopCommand(`${remoteTrainingDir(await remoteRoot(host), project.id)}/run.pid`), REMOTE_TIMEOUT_MS)
  } catch (error) {
    warn(`stopping the remote run of ${project.id}`, error)
  }
}

/** The version a run uses: the one the training names, else the newest ready one at its host. */
async function trainerVersion(settings: Settings, project: TrainingProject): Promise<TrainerVersion> {
  const versions = project.hostId === 'local' ? await listTrainerVersions(settings) : remoteVersions(settings, project.hostId)
  const ready = versions.filter((version) => version.status === 'ok' && version.runtimeState === 'ready')
  const version = project.versionId ? ready.find((item) => item.id === project.versionId) : ready[0]
  if (!version) throw codedError('E_TRAINING_TRAINER', '训练器还没准备好。先在训练页点「准备」。')
  return version
}

/** `<trigger or kind>-<short id>`, with `-2`, `-3`… on later runs of the same training. */
export function nextRunName(project: Pick<TrainingProject, 'id' | 'kind' | 'trigger' | 'runName'>): string {
  const base = `${project.trigger || project.kind}-${project.id.split('-').pop() ?? project.id}`.replace(/[^A-Za-z0-9_-]/g, '-')
  if (!project.runName?.startsWith(base)) return base
  const previous = Number.parseInt(/-(\d+)$/.exec(project.runName.slice(base.length))?.[1] ?? '1', 10)
  return `${base}-${previous + 1}`
}

interface PreparedPlan {
  plan: TrainingCommandPlan
  bundleId: string
  host: TrainingHost | null
  version: TrainerVersion
  remoteDir: string | null
}

/** The run's plan; `materialize` links the local weights into place (a start), else only names them. */
async function preparePlan(project: TrainingProject, runName: string, materialize: boolean): Promise<PreparedPlan> {
  const settings = getSettings()
  const version = await trainerVersion(settings, project)
  if (project.hostId === 'local') {
    const runtime = await trainerRuntimeSummary(settings, version.id)
    if (!runtime || runtime.state !== 'ready') throw codedError('E_TRAINING_TRAINER', '训练环境还没装好。先在训练页点「准备」。')
    const windows = process.platform === 'win32'
    const bin = join(runtime.path, windows ? 'Scripts' : 'bin')
    const weights = materialize ? await localWeightsFolder(settings) : await plannedWeightsFolder(settings)
    return {
      bundleId: weights.bundleId,
      host: null,
      version,
      remoteDir: null,
      plan: {
        shell: windows ? 'powershell' : 'posix',
        versionDir: version.path,
        configBin: join(bin, windows ? 'kohakumoss-config.exe' : 'kohakumoss-config'),
        kogine: join(bin, windows ? 'kogine.exe' : 'kogine'),
        weights: weights.path,
        data: stagedDir(project.id),
        outputDir: join(projectDir(project.id), 'runs'),
        cacheDir: join(projectDir(project.id), 'cache'),
        configDir: join(projectDir(project.id), 'configs'),
        runName,
        recipe: project.recipe,
      },
    }
  }
  const host = sshHost(settings, project.hostId)
  if (!version.runtimeId) throw codedError('E_TRAINING_TRAINER', '训练环境还没装好。先在训练页点「准备」。')
  const root = await remoteRoot(host)
  const dir = remoteTrainingDir(root, project.id)
  const runtime = `${root}/runtimes/${version.runtimeId}`
  return {
    bundleId: 'moss-base-int8',
    host,
    version,
    remoteDir: dir,
    plan: {
      shell: 'remote',
      versionDir: `${root}/versions/${version.id}`,
      configBin: `${runtime}/bin/kohakumoss-config`,
      kogine: `${runtime}/bin/kogine`,
      weights: await remoteWeights(host),
      data: `${dir}/dataset`,
      outputDir: `${dir}/runs`,
      cacheDir: `${dir}/cache`,
      configDir: `${dir}/configs`,
      runName,
      recipe: project.recipe,
      pidFile: `${dir}/run.pid`,
    },
  }
}

/** The commands the next run will execute, for copying. Nothing is written or linked for it. */
export async function trainingCommand(id: string): Promise<string> {
  const project = await getTrainingProject(id)
  const runName = isBusy(project) && project.runName ? project.runName : nextRunName(project)
  return trainingScript((await preparePlan(project, runName, false)).plan)
}

async function startLocal(prepared: PreparedPlan, project: TrainingProject): Promise<JobRecord> {
  const { plan, version } = prepared
  const script = join(projectDir(project.id), plan.shell === 'powershell' ? 'run.ps1' : 'run.sh')
  // Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page, which breaks non-ASCII paths.
  await writeFile(script, `${plan.shell === 'powershell' ? '﻿' : ''}${trainingScript(plan)}`, { encoding: 'utf8', mode: 0o755 })
  const gpu = await localTrainingGpu().catch(() => null)
  return startTrainingJob({
    versionId: version.id,
    runName: plan.runName,
    action: 'train',
    weights: plan.weights,
    algo: plan.recipe.algo,
    name: project.name,
    cwd: version.path,
    command: plan.shell === 'powershell' ? 'powershell.exe' : 'bash',
    args:
      plan.shell === 'powershell' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] : [script],
    // nvidia-smi numbers cards by PCI bus; CUDA's default order is fastest first.
    env: gpu ? { CUDA_DEVICE_ORDER: 'PCI_BUS_ID', CUDA_VISIBLE_DEVICES: String(gpu.index) } : {},
    totalSteps: plan.recipe.steps,
  })
}

async function startRemote(prepared: PreparedPlan, project: TrainingProject, staged: string): Promise<JobRecord> {
  const { plan, version } = prepared
  const host = prepared.host!
  const dir = prepared.remoteDir!
  const root = dir.slice(0, dir.lastIndexOf('/training/'))
  const busy = await sshExec(host, remoteBusyCommand(root), REMOTE_TIMEOUT_MS)
  if (busy.code !== 0) throw codedError('E_TRAINING_HOST', `连不上训练主机「${host.name}」。请检查网络和主机设置。`)
  if (busy.stdout.includes('busy')) {
    throw codedError('E_TRAINING_BUSY', '训练主机上还有一个训练在运行（可能是上次没停下的）。等它结束，或在主机上结束它后再开始。')
  }
  // The pictures go up fresh each run, so pictures removed here are gone there too.
  const clean = await sshExec(host, `mkdir -p ${posixQuote(dir)} && rm -rf ${posixQuote(plan.data)}`, REMOTE_TIMEOUT_MS)
  if (clean.code !== 0) throw codedError('E_TRAINING_HOST', `连不上训练主机「${host.name}」。请检查网络和主机设置。`)
  const upload = await scpTo(host, staged, plan.data, UPLOAD_TIMEOUT_MS, true)
  if (upload.code !== 0) {
    console.warn('[training]', 'upload failed:', (upload.stderr || upload.stdout).trim().slice(-400))
    throw codedError('E_TRAINING_UPLOAD', '图片没能传到训练主机。请检查网络后再试。')
  }
  const script = `${dir}/run.sh`
  await sshWriteFile(host, script, Buffer.from(trainingScript(plan), 'utf8'), REMOTE_TIMEOUT_MS)
  // Its own session, so 停止 can end the whole tree (the trainer starts workers) by its group.
  const start = `if command -v setsid >/dev/null 2>&1; then exec setsid -w bash ${posixQuote(script)}; else exec bash ${posixQuote(script)}; fi`
  return startTrainingJob({
    versionId: version.id,
    hostId: host.id,
    runName: plan.runName,
    action: 'train',
    weights: plan.weights,
    algo: plan.recipe.algo,
    name: `${project.name} · ${host.name}`,
    cwd: process.cwd(),
    command: sshCommand(),
    env: sshEnv(host),
    args: sshArgs(host, start),
    totalSteps: plan.recipe.steps,
    cancelCommand: { command: sshCommand(), args: sshArgs(host, remoteStopCommand(plan.pidFile!)), env: sshEnv(host) },
  })
}

/** Everything between `starting` and a started job; any failure here sends the training back to a draft. */
async function launch(project: TrainingProject): Promise<{ job: JobRecord; runName: string }> {
  if (!(await scanDataset(project.id)).images.length) throw codedError('E_TRAINING_EMPTY', '先添加至少一张图片。')
  const readiness = await trainingReadiness(project.hostId)
  if (!readiness.ready) throw codedError('E_TRAINING_NOT_READY', '这台电脑还没准备好训练。先在训练页完成准备。')
  const busy = (await listJobs()).find((job) => job.kind === 'training' && (job.hostId ?? 'local') === project.hostId && jobLive(job))
  if (busy) throw codedError('E_TRAINING_BUSY', '这台电脑上已经有一个训练在进行。等它结束或停止后再开始。')
  const runName = nextRunName(project)
  const prepared = await preparePlan(project, runName, true)
  startingHere.set(project.id, prepared.version.id)
  // The run reads a copy whose descriptions name the trigger; the person's own stay as written.
  const staged = await stageDataset(project)
  const job = project.hostId === 'local' ? await startLocal(prepared, project) : await startRemote(prepared, project, staged)
  return { job, runName }
}

export async function trainingStart(id: string): Promise<TrainingProject> {
  // Through the write queue: a second start, an edit or a delete queued behind this sees `starting`.
  let marked = false
  let starting: TrainingProject
  try {
    starting = await mutateTrainingProject(id, (current) => {
      if (isBusy(current)) throw codedError('E_TRAINING_RUNNING', '这个训练已经在开始或进行了。')
      if (current.state === 'done') throw codedError('E_TRAINING_DONE', '这个训练已经完成。想再练一次，可以复制一份。')
      // Before the write, so a list running meanwhile does not take it for a start the app lost.
      startingHere.set(id, null)
      marked = true
      return { ...current, state: 'starting' }
    })
  } catch (error) {
    if (marked) startingHere.delete(id)
    throw error
  }
  await changed(starting)
  let launched: { job: JobRecord; runName: string }
  try {
    launched = await launch(starting)
  } catch (error) {
    startingHere.delete(id)
    const draft = await mutateTrainingProject(id, (current) => (current.state === 'starting' ? { ...current, state: 'draft' } : current))
    await changed(draft)
    throw error
  }
  const { job, runName } = launched
  const started = await mutateTrainingProject(id, (current) => ({
    ...current,
    state: 'running',
    jobId: job.id,
    runName,
    startedAt: job.startedAt,
    finishedAt: null,
    stepReached: 0,
    chosenStep: null,
    saveError: null,
    saveErrorStep: null,
    failure: null,
  }))
  startingHere.delete(id)
  await changed(started)
  // A job that ended before its id was saved found no training when it ended; settle it now.
  const now = await getJob(job.id)
  if (now && !jobLive(now)) await onTrainingJobEnded(now)
  return present(await getTrainingProject(id))
}

export async function trainingStop(id: string): Promise<TrainingProject> {
  const project = await getTrainingProject(id)
  if (project.state === 'running' && project.jobId) {
    const job = await cancelJob(project.jobId)
    // The job may already be gone (the app restarted): settle the training now.
    if (!job || !jobLive(job)) await settle(project)
  }
  return present(await getTrainingProject(id))
}

async function finishAs(
  id: string,
  jobId: string | null,
  outcome: Pick<TrainingProject, 'state'> & Partial<Pick<TrainingProject, 'failure' | 'stepReached'>>,
): Promise<TrainingProject | null> {
  let ended: TrainingProject | null = null
  await mutateTrainingProject(id, (project) => {
    // Already settled by another path (a restart and the completion listener racing).
    if (project.state !== 'running' || project.jobId !== jobId) return project
    ended = { ...project, ...outcome, finishedAt: new Date().toISOString() }
    return ended
  })
  return ended
}

async function reachedStep(project: TrainingProject, job: JobRecord): Promise<number> {
  const checkpoints = await checkpointSteps(project)
  return Math.max(job.progress.current, checkpoints.at(-1) ?? 0)
}

async function syncIfRemote(project: TrainingProject): Promise<void> {
  if (project.hostId === 'local' || !project.runName) return
  try {
    const host = sshHost(getSettings(), project.hostId)
    await syncRemoteRun(project, host, `${remoteTrainingDir(await remoteRoot(host), project.id)}/runs/${project.runName}`)
  } catch (error) {
    warn('remote samples', error)
  }
}

/** A training job ended: the training follows (done, failed or stopped) and a finished run saves its last step. */
export async function onTrainingJobEnded(job: JobRecord): Promise<void> {
  if (job.kind !== 'training') return
  const project = (await listTrainingProjects()).find((item) => item.jobId === job.id)
  if (!project || project.state !== 'running') return
  // A failed SSH session (a dropped connection) leaves the trainer running in its own session.
  if (project.hostId !== 'local' && job.state === 'failed') await stopRemoteRun(project)
  await syncIfRemote(project)
  if (job.state === 'succeeded') {
    const done = await finishAs(project.id, job.id, { state: 'done', stepReached: project.recipe.steps })
    if (!done) return
    await changed(done)
    const saved = await trainingChooseStep(project.id, project.recipe.steps)
    pushLocalNotification({ title: '训练完成', body: `${saved.name} · 挑一个最好的步数保存`, windowKind: 'studio', route: '/training' })
    return
  }
  if (job.state === 'canceled') {
    const stopped = await finishAs(project.id, job.id, { state: 'stopped', stepReached: await reachedStep(project, job) })
    if (stopped) await changed(stopped)
    return
  }
  const failure =
    job.error?.code === 'E_INTERRUPTED'
      ? INTERRUPTED
      : trainingFailureReason([...(await getJobLogs(job.id)).slice(-120).map((line) => line.text), job.error?.message ?? ''])
  const failed = await finishAs(project.id, job.id, { state: 'failed', failure, stepReached: await reachedStep(project, job) })
  if (!failed) return
  await changed(failed)
  pushLocalNotification({
    title: '训练没有完成',
    body: `${failed.name} · ${failure === GENERIC_FAILURE ? '查看原因' : failure}`,
    windowKind: 'studio',
    route: '/training',
  })
}

/** The local file of step `step`'s LoRA: found in the run folder, or copied down from the host. */
async function exportFile(project: TrainingProject, step: number): Promise<{ path: string; temporary: string | null } | null> {
  const runName = project.runName!
  const candidates = exportCandidates(runName, step, project.recipe.steps)
  if (project.hostId === 'local') {
    const found = candidates.map((relative) => join(localRunDir(project), ...relative.split('/'))).find((path) => existsSync(path))
    return found ? { path: found, temporary: null } : null
  }
  const host = sshHost(getSettings(), project.hostId)
  const runDir = `${remoteTrainingDir(await remoteRoot(host), project.id)}/runs/${runName}`
  const probe = await sshExec(
    host,
    [
      `cd ${posixQuote(runDir)} || exit 1`,
      ...candidates.map((relative) => `if [ -f ${posixQuote(relative)} ]; then echo ${posixQuote(relative)}; exit 0; fi`),
    ].join('\n'),
    REMOTE_TIMEOUT_MS,
  )
  const relative = probe.stdout.trim().split('\n').pop()
  if (probe.code !== 0 || !relative || !candidates.includes(relative)) return null
  // A folder per step; the file keeps the trainer's name, which the adapter keeps.
  const folder = join(projectDir(project.id), 'download', stepFolder(step))
  await mkdir(folder, { recursive: true })
  const local = join(folder, exportFileName(runName))
  const copied = await scpFrom(host, `${runDir}/${relative}`, local, DOWNLOAD_TIMEOUT_MS)
  if (copied.code !== 0) {
    await rm(folder, { recursive: true, force: true })
    throw new Error((copied.stderr || copied.stdout).trim().slice(-400) || 'scp failed')
  }
  return { path: local, temporary: folder }
}

/** Saves step `step`'s checkpoint as the training's LoRA, one save per training at a time; a failure lands in `saveError`. */
export function trainingChooseStep(id: string, step: number): Promise<TrainingProject> {
  return saves(id, () => saveStep(id, step))
}

async function saveStep(id: string, step: number): Promise<TrainingProject> {
  const project = await getTrainingProject(id)
  if (isBusy(project)) throw codedError('E_TRAINING_RUNNING', '训练还在进行。等它结束或停止后再选。')
  if (!project.runName) throw codedError('E_TRAINING_NO_RUN', '这个训练还没有结果。')
  let saveError: string | null = null
  let adapterId = project.adapterId
  let file: { path: string; temporary: string | null } | null = null
  try {
    file = await exportFile(project, step)
    if (!file) saveError = `没有找到第 ${step} 步保存的 LoRA。换一步试试。`
    else {
      const settings = getSettings()
      const adapter = await registerTrainedAdapter(settings, {
        id: `trained-${project.id}`,
        name: project.name,
        sourcePath: file.path,
        kind: 'lora',
        base: project.hostId === 'local' ? ((await installedBaseBundle(settings))?.id ?? 'moss-base-int8') : 'moss-base-int8',
        license: 'local',
      })
      adapterId = adapter.id
    }
  } catch (error) {
    warn(`saving step ${step} of ${id}`, error)
    saveError =
      project.hostId === 'local'
        ? `第 ${step} 步的 LoRA 没能存进模型库。检查磁盘空间后重试。`
        : `第 ${step} 步的 LoRA 没能从训练主机取回。检查网络后重试。`
  } finally {
    if (file?.temporary) await rm(file.temporary, { recursive: true, force: true }).catch(() => undefined)
  }
  const saved = await mutateTrainingProject(id, (current) =>
    saveError
      ? { ...current, saveError, saveErrorStep: step }
      : { ...current, chosenStep: step, adapterId, saveError: null, saveErrorStep: null },
  )
  return changed(saved)
}

export async function trainingSamples(id: string): Promise<TrainingSamples> {
  const project = await getTrainingProject(id)
  await syncIfRemote(project)
  const reached =
    project.state === 'running' && project.jobId ? ((await getJob(project.jobId))?.progress.current ?? 0) : project.stepReached
  return listSamples(project, reached)
}

export async function trainingReveal(id: string): Promise<void> {
  const project = await getTrainingProject(id)
  const adapter = project.adapterId ? await resolveAdapterFile(getSettings(), project.adapterId) : null
  if (adapter) return revealInFileManager(adapter)
  const run = project.runName ? localRunDir(project) : null
  await revealInFileManager(run && existsSync(run) ? run : projectDir(project.id))
}
