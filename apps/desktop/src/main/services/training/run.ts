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
import { scanDataset, writeCaptions } from './dataset'
import { GENERIC_FAILURE, trainingFailureReason } from './failure'
import { installedBaseBundle, localTrainingGpu, samplesByDefault, trainingReadiness } from './readiness'
import { checkpointSteps, coverOf, exportCandidates, exportFileName, listSamples, localRunDir, syncRemoteRun } from './samples'
import {
  createTrainingProject,
  duplicateTrainingProject,
  getTrainingProject,
  imagesDir,
  listTrainingProjects,
  mutateTrainingProject,
  projectDir,
  removeTrainingProject,
  updateTrainingProject,
  type TrainingPatch,
} from './store'
import { comfyWeightsFolder, localWeightsFolder } from './weights'

const REMOTE_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 30 * 60_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const INTERRUPTED = '训练被打断了：应用关闭时它还在进行。可以重新开始。'

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

export async function trainingList(): Promise<TrainingProject[]> {
  const projects = await listTrainingProjects()
  // A run that ended while nothing listened (the app was closed) is settled here.
  for (const project of projects.filter((item) => item.state === 'running')) await settleIfEnded(project)
  return Promise.all((await listTrainingProjects()).map(present))
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
    console.warn('[training]', `remote files of ${id} stay:`, error instanceof Error ? error.message : error)
  }
}

export async function trainingGet(id: string): Promise<TrainingProject> {
  const project = await getTrainingProject(id)
  if (project.state === 'running') await settleIfEnded(project)
  return present(await getTrainingProject(id))
}

async function settleIfEnded(project: TrainingProject): Promise<void> {
  const job = project.jobId ? await getJob(project.jobId) : null
  if (job && (job.state === 'running' || job.state === 'starting' || job.state === 'queued')) return
  if (job) await onTrainingJobEnded(job)
  else await finishAs(project.id, project.jobId, { state: 'failed', failure: INTERRUPTED })
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

async function preparePlan(project: TrainingProject, runName: string, materialize: boolean): Promise<PreparedPlan> {
  const settings = getSettings()
  const version = await trainerVersion(settings, project)
  if (project.hostId === 'local') {
    const runtime = await trainerRuntimeSummary(settings, version.id)
    if (!runtime || runtime.state !== 'ready') throw codedError('E_TRAINING_TRAINER', '训练环境还没装好。先在训练页点「准备」。')
    const windows = process.platform === 'win32'
    const bin = join(runtime.path, windows ? 'Scripts' : 'bin')
    const installed = await installedBaseBundle(settings)
    const weights = materialize
      ? await localWeightsFolder(settings)
      : installed && installed.id !== 'moss-base-int8'
        ? await localWeightsFolder(settings)
        : { bundleId: 'moss-base-int8', path: comfyWeightsFolder(settings, 'moss-base-int8') }
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
        data: imagesDir(project.id),
        outputDir: join(projectDir(project.id), 'runs'),
        cacheDir: join(projectDir(project.id), 'cache'),
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
      data: `${dir}/images`,
      outputDir: `${dir}/runs`,
      cacheDir: `${dir}/cache`,
      runName,
      recipe: project.recipe,
      pidFile: `${dir}/run.pid`,
    },
  }
}

/** The commands the next run will execute, for copying. */
export async function trainingCommand(id: string): Promise<string> {
  const project = await getTrainingProject(id)
  const runName = project.state === 'running' && project.runName ? project.runName : nextRunName(project)
  return trainingScript((await preparePlan(project, runName, false)).plan)
}

/** Whether `caption` already names the trigger as a word of its own. */
export function mentionsTrigger(caption: string, trigger: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${trigger}($|[^A-Za-z0-9_])`).test(caption)
}

/** For 人物 and 物品 every description must call the subject by its trigger word. */
async function addTriggerToCaptions(project: TrainingProject): Promise<void> {
  if (project.kind === 'style' || !project.trigger) return
  const updates = new Map<string, string>()
  for (const image of (await scanDataset(project.id)).images) {
    const caption = image.caption?.trim() ?? ''
    if (!caption) updates.set(image.name, project.trigger)
    else if (!mentionsTrigger(caption, project.trigger)) updates.set(image.name, `${project.trigger}，${caption}`)
  }
  await writeCaptions(project.id, updates)
}

async function startLocal(prepared: PreparedPlan, project: TrainingProject): Promise<JobRecord> {
  const { plan, version } = prepared
  const script = join(projectDir(project.id), plan.shell === 'powershell' ? 'run.ps1' : 'run.sh')
  // Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page, which breaks non-ASCII paths.
  await writeFile(script, `${plan.shell === 'powershell' ? '\uFEFF' : ''}${trainingScript(plan)}`, { encoding: 'utf8', mode: 0o755 })
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

async function startRemote(prepared: PreparedPlan, project: TrainingProject): Promise<JobRecord> {
  const { plan, version } = prepared
  const host = prepared.host!
  const dir = prepared.remoteDir!
  // The pictures go up fresh each run, so pictures removed here are gone there too.
  const clean = await sshExec(host, `mkdir -p ${posixQuote(dir)} && rm -rf ${posixQuote(`${dir}/images`)}`, REMOTE_TIMEOUT_MS)
  if (clean.code !== 0) throw codedError('E_TRAINING_HOST', `连不上训练主机「${host.name}」。请检查网络和主机设置。`)
  const upload = await scpTo(host, imagesDir(project.id), `${dir}/images`, UPLOAD_TIMEOUT_MS, true)
  if (upload.code !== 0) {
    console.warn('[training]', 'upload failed:', (upload.stderr || upload.stdout).trim().slice(-400))
    throw codedError('E_TRAINING_UPLOAD', '图片没能传到训练主机。请检查网络后再试。')
  }
  const script = `${dir}/run.sh`
  await sshWriteFile(host, script, Buffer.from(trainingScript(plan), 'utf8'), REMOTE_TIMEOUT_MS)
  // Its own session, so 停止 can end the whole tree (the trainer starts workers) by its group.
  const start = `if command -v setsid >/dev/null 2>&1; then exec setsid -w bash ${posixQuote(script)}; else exec bash ${posixQuote(script)}; fi`
  const stop = `P="$(cat ${posixQuote(plan.pidFile!)} 2>/dev/null)" && [ -n "$P" ] && { kill -TERM -- "-$P" 2>/dev/null || kill -TERM "$P" 2>/dev/null; }; true`
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
    cancelCommand: { command: sshCommand(), args: sshArgs(host, stop), env: sshEnv(host) },
  })
}

export async function trainingStart(id: string): Promise<TrainingProject> {
  const project = await getTrainingProject(id)
  if (project.state === 'running') throw codedError('E_TRAINING_RUNNING', '这个训练已经在进行了。')
  if (project.state === 'done') throw codedError('E_TRAINING_DONE', '这个训练已经完成。想再练一次，可以复制一份。')
  if (!(await scanDataset(id)).images.length) throw codedError('E_TRAINING_EMPTY', '先添加至少一张图片。')
  const readiness = await trainingReadiness(project.hostId)
  if (!readiness.ready) throw codedError('E_TRAINING_NOT_READY', '这台电脑还没准备好训练。先在训练页完成准备。')
  const busy = (await listJobs()).find(
    (job) => job.kind === 'training' && (job.hostId ?? 'local') === project.hostId && (job.state === 'running' || job.state === 'starting'),
  )
  if (busy) throw codedError('E_TRAINING_BUSY', '这台电脑上已经有一个训练在进行。等它结束或停止后再开始。')
  const runName = nextRunName(project)
  const prepared = await preparePlan(project, runName, true)
  await addTriggerToCaptions(project)
  const job = project.hostId === 'local' ? await startLocal(prepared, project) : await startRemote(prepared, project)
  const started = await mutateTrainingProject(id, (current) => ({
    ...current,
    state: 'running',
    jobId: job.id,
    runName,
    startedAt: job.startedAt,
    finishedAt: null,
    stepReached: 0,
    chosenStep: null,
    adapterId: current.adapterId,
    saveError: null,
    failure: null,
  }))
  return changed(started)
}

export async function trainingStop(id: string): Promise<TrainingProject> {
  const project = await getTrainingProject(id)
  if (project.state === 'running' && project.jobId) {
    const job = await cancelJob(project.jobId)
    // The job may already be gone (the app restarted): settle the training now.
    if (!job || (job.state !== 'running' && job.state !== 'starting')) await settleIfEnded(project)
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
    console.warn('[training]', 'remote samples:', error instanceof Error ? error.message : error)
  }
}

/** A training job ended: the training follows (done, failed or stopped) and a finished run saves its last step. */
export async function onTrainingJobEnded(job: JobRecord): Promise<void> {
  if (job.kind !== 'training') return
  const project = (await listTrainingProjects()).find((item) => item.jobId === job.id)
  if (!project || project.state !== 'running') return
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
async function exportFile(project: TrainingProject, step: number): Promise<{ path: string; temporary: boolean } | null> {
  const runName = project.runName!
  const candidates = exportCandidates(runName, step, project.recipe.steps)
  if (project.hostId === 'local') {
    const found = candidates.map((relative) => join(localRunDir(project), ...relative.split('/'))).find((path) => existsSync(path))
    return found ? { path: found, temporary: false } : null
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
  // Named as the trainer named it: the adapter keeps the file name.
  const local = join(projectDir(project.id), 'download', exportFileName(runName))
  await mkdir(join(projectDir(project.id), 'download'), { recursive: true })
  const copied = await scpFrom(host, `${runDir}/${relative}`, local, DOWNLOAD_TIMEOUT_MS)
  if (copied.code !== 0) throw new Error((copied.stderr || copied.stdout).trim().slice(-400) || 'scp failed')
  return { path: local, temporary: true }
}

/** Saves step `step`'s checkpoint as the training's LoRA; a failure lands in `saveError`. */
export async function trainingChooseStep(id: string, step: number): Promise<TrainingProject> {
  const project = await getTrainingProject(id)
  if (project.state === 'running') throw codedError('E_TRAINING_RUNNING', '训练还在进行。等它结束或停止后再选。')
  if (!project.runName) throw codedError('E_TRAINING_NO_RUN', '这个训练还没有结果。')
  let saveError: string | null = null
  let adapterId = project.adapterId
  let file: { path: string; temporary: boolean } | null = null
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
    console.warn('[training]', `saving step ${step} of ${id} failed:`, error instanceof Error ? error.message : error)
    saveError =
      project.hostId === 'local'
        ? `第 ${step} 步的 LoRA 没能存进模型库。检查磁盘空间后重试。`
        : `第 ${step} 步的 LoRA 没能从训练主机取回。检查网络后重试。`
  } finally {
    if (file?.temporary) await rm(file.path, { force: true }).catch(() => undefined)
  }
  const saved = await mutateTrainingProject(id, (current) =>
    saveError ? { ...current, saveError } : { ...current, chosenStep: step, adapterId, saveError: null },
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
