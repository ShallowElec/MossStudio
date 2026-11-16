/**
 * Whether a computer can train, and the one action that gets it there: the base model, the
 * trainer (a KohakuMossTrainer version) and its Python environment, prepared in the background.
 */
import { totalmem } from 'node:os'
import { Events } from '@shared/channels'
import { MIN_TRAINING_VRAM_BYTES, type TrainingBlockReason, type TrainingPrepareStep, type TrainingReadiness } from '@shared/training'
import type { GpuInventoryDevice, ModelBundle, Settings, TrainerVersion, TrainingHost } from '@shared/types'
import { codedError, errorCode } from '../../lib/codedError'
import { freeSpace } from '../../lib/disk'
import { emit } from '../../lib/events'
import { paths } from '../../lib/paths'
import { getGpuInventory } from '../devices'
import { getCatalog, installBundle, modelMissingBytes, waitForDownload } from '../models'
import { getSettings } from '../settings'
import { sshExec } from '../ssh'
import { remoteBranches, remoteCreateVersion, remoteInstallRuntime, remoteSetup, remoteVersions, rootExpression } from '../remoteTrainer'
import { createTrainerVersion, installTrainerRuntime, listTrainerVersions } from '../trainers'
import { listTrainerBranches, trainerTagSha } from '../trainerGit'
import { getTrainingHost } from '../trainingHosts'

/** The bundle the trainer reads as a ComfyUI folder (its default file names), then the HF one. */
export const BASE_BUNDLE_IDS = ['moss-base-int8', 'moss-base'] as const
const BASE_DOWNLOAD = 'moss-base-int8'
const BASE_NAME = 'MOSS-Image Base INT8'
/** The weight files the trainer looks for in a ComfyUI models folder (KohakuMossTrainer weights_comfy.py). */
export const COMFY_WEIGHT_FILES = {
  dit: 'diffusion_models/moss_image_base_int8_convrot.safetensors',
  textEncoder: 'text_encoders/qwen3.5_9b_int8_convrot.safetensors',
  vae: 'vae/flux2-vae_small.safetensors',
} as const

const GIB = 1024 ** 3
/** VRAM below which the trainer's small layers stream weights through host RAM (configs.md, host RAM). */
const RAM_SENSITIVE_VRAM = 16 * GIB
const MIN_RAM_FOR_SMALL_VRAM = 32 * GIB
const SAMPLES_ABOVE_VRAM = 8 * GIB
/** Room for the trainer's environment, the caches and the checkpoints of one run. */
const RUN_SPACE = 8 * GIB
const ENVIRONMENT_SPACE = 12 * GIB
const REMOTE_PROBE_TIMEOUT_MS = 30_000

interface PrepareState {
  running: boolean
  step: TrainingPrepareStep | null
  error: string | null
  /** The step that failed, so the trainer shows `error` only when it was the trainer's. */
  failedStep: TrainingPrepareStep | null
}

const prepares = new Map<string, PrepareState>()

function prepareOf(hostId: string): PrepareState {
  return prepares.get(hostId) ?? { running: false, step: null, error: null, failedStep: null }
}

export function isNvidia(device: GpuInventoryDevice): boolean {
  return device.vendor === undefined || device.vendor === 'nvidia'
}

/** The NVIDIA card a local run uses: the one with the most memory. */
export async function localTrainingGpu(): Promise<GpuInventoryDevice | null> {
  const inventory = await getGpuInventory()
  const cards = inventory.devices.filter(isNvidia)
  return cards.sort((a, b) => (b.memoryTotalBytes ?? 0) - (a.memoryTotalBytes ?? 0))[0] ?? null
}

/** `name, memory` rows as nvidia-smi prints them (`--format=csv,noheader[,nounits]`), largest first. */
export function parseGpuRows(text: string): Array<{ name: string; memoryBytes: number | null }> {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = '', memory = ''] = line.split(',').map((part) => part.trim())
      const mib = Number.parseInt(memory, 10)
      return { name, memoryBytes: Number.isFinite(mib) ? mib * 1024 * 1024 : null }
    })
    .filter((row) => row.name)
    .sort((a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0))
}

export interface MachineFacts {
  mac: boolean
  gpu: { name: string; memoryBytes: number | null } | null
  ramBytes: number | null
}

/** The verdict from the machine alone; the trainer needs CUDA and does not run on macOS (MPS). */
export function judgeMachine(facts: MachineFacts): {
  blockReason: TrainingBlockReason | null
  gpuOk: boolean
  ramLow: boolean
  samplesByDefault: boolean
} {
  const memory = facts.gpu?.memoryBytes ?? null
  const blockReason: TrainingBlockReason | null = facts.mac
    ? 'mac'
    : !facts.gpu
      ? 'no-nvidia'
      : memory !== null && memory < MIN_TRAINING_VRAM_BYTES
        ? 'low-vram'
        : null
  return {
    blockReason,
    gpuOk: blockReason === null,
    ramLow: memory !== null && memory < RAM_SENSITIVE_VRAM && facts.ramBytes !== null && facts.ramBytes < MIN_RAM_FOR_SMALL_VRAM,
    samplesByDefault: memory === null || memory > SAMPLES_ABOVE_VRAM,
  }
}

/** Whether samples default to on for a new training here, without asking the host anything. */
export async function samplesByDefault(settings: Settings, hostId: string): Promise<boolean> {
  if (hostId === 'local') {
    const gpu = await localTrainingGpu().catch(() => null)
    return judgeMachine({ mac: false, gpu: gpu ? { name: gpu.name, memoryBytes: gpu.memoryTotalBytes ?? null } : null, ramBytes: null })
      .samplesByDefault
  }
  const gpu = parseGpuRows(getTrainingHost(settings, hostId)?.remote?.gpu ?? '')[0] ?? null
  return judgeMachine({ mac: false, gpu, ramBytes: null }).samplesByDefault
}

function bundleInstalled(bundle: ModelBundle, installed: Set<string>): boolean {
  return [...Object.values(bundle.components), bundle.support].every((id) => installed.has(id))
}

/** The base bundle a local run trains on, preferring the INT8 one; null when neither is installed. */
export async function installedBaseBundle(settings: Settings): Promise<ModelBundle | null> {
  const catalog = await getCatalog(settings)
  const installed = new Set(catalog.models.filter((model) => model.installed).map((model) => model.id))
  for (const id of BASE_BUNDLE_IDS) {
    const bundle = catalog.bundles.find((item) => item.id === id)
    if (bundle && bundleInstalled(bundle, installed)) return bundle
  }
  return null
}

async function localBaseModel(settings: Settings): Promise<TrainingReadiness['baseModel']> {
  const bundle = await installedBaseBundle(settings)
  if (bundle) return { bundleId: bundle.id, name: bundle.name, installed: true, missingBytes: 0 }
  const catalog = await getCatalog(settings)
  const download = catalog.bundles.find((item) => item.id === BASE_DOWNLOAD)
  let missingBytes = 0
  for (const id of download ? [...Object.values(download.components), download.support] : []) {
    const model = catalog.models.find((item) => item.id === id)
    if (model && !model.installed) missingBytes += await modelMissingBytes(settings, model)
  }
  return { bundleId: BASE_DOWNLOAD, name: download?.name ?? BASE_NAME, installed: false, missingBytes }
}

function trainerOf(versions: TrainerVersion[], prepare: PrepareState): TrainingReadiness['trainer'] {
  const ready = versions.find((version) => version.status === 'ok' && version.runtimeState === 'ready')
  if (prepare.running && (prepare.step === 'trainer' || prepare.step === 'environment')) {
    return { versionId: ready?.id ?? null, state: 'installing' }
  }
  if (ready) return { versionId: ready.id, state: 'ready' }
  if (prepare.error && (prepare.failedStep === 'trainer' || prepare.failedStep === 'environment'))
    return { versionId: null, state: 'error' }
  return { versionId: null, state: 'missing' }
}

function assemble(
  hostId: string,
  facts: MachineFacts,
  baseModel: TrainingReadiness['baseModel'],
  trainer: TrainingReadiness['trainer'],
  disk: { path: string; freeBytes: number | null },
): TrainingReadiness {
  const verdict = judgeMachine(facts)
  const prepare = prepareOf(hostId)
  const needed = baseModel.missingBytes + (trainer.state === 'ready' ? RUN_SPACE : RUN_SPACE + ENVIRONMENT_SPACE)
  const diskOk = disk.freeBytes === null || disk.freeBytes >= needed
  return {
    hostId,
    gpu: { name: facts.gpu?.name ?? '', memoryBytes: facts.gpu?.memoryBytes ?? null, ok: verdict.gpuOk },
    ramBytes: facts.ramBytes,
    ramLow: verdict.ramLow,
    baseModel,
    trainer,
    disk: { ...disk, ok: diskOk },
    blockReason: verdict.blockReason,
    ready: verdict.blockReason === null && baseModel.installed && trainer.state === 'ready' && diskOk && !prepare.running,
    prepare: { running: prepare.running, step: prepare.step, error: prepare.error },
    samplesByDefault: verdict.samplesByDefault,
  }
}

async function localReadiness(settings: Settings): Promise<TrainingReadiness> {
  const gpu = await localTrainingGpu().catch(() => null)
  const free = await freeSpace(paths.training())
  return assemble(
    'local',
    {
      mac: process.platform === 'darwin',
      gpu: gpu ? { name: gpu.name, memoryBytes: gpu.memoryTotalBytes ?? null } : null,
      ramBytes: totalmem(),
    },
    await localBaseModel(settings),
    trainerOf(await listTrainerVersions(settings), prepareOf('local')),
    { path: paths.training(), freeBytes: Number.isFinite(free) ? free : null },
  )
}

function section(output: string, name: string): string {
  return (output.match(new RegExp(`@@${name}@@([\\s\\S]*?)(?=@@[A-Z]+@@|$)`))?.[1] ?? '').trim()
}

function sshHost(settings: Settings, hostId: string): TrainingHost {
  const host = getTrainingHost(settings, hostId)
  if (!host || host.kind !== 'ssh') throw codedError('E_TRAINING_HOST', '找不到这台训练主机，请在设置里检查主机。')
  return host
}

/** One SSH round trip: the system, cards, memory, free space and whether the base weights are there. */
async function probeRemote(host: TrainingHost): Promise<{ facts: MachineFacts; freeBytes: number | null; weights: boolean }> {
  const weights = host.weightsPath
    ? [
        `W=${rootExpression(host.weightsPath)}`,
        `if [ -f "$W/${COMFY_WEIGHT_FILES.dit}" ] || [ -d "$W/transformer" ]; then echo yes; else echo no; fi`,
      ]
    : ['echo no']
  const command = [
    remoteSetup(host),
    'printf "@@OS@@"; uname -s 2>/dev/null || true',
    'printf "@@GPU@@"; nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null || true',
    `printf "@@RAM@@"; awk '/MemTotal/ {printf "%.0f\\n", $2 * 1024}' /proc/meminfo 2>/dev/null || true`,
    `printf "@@DISK@@"; df -Pk "$ROOT" 2>/dev/null | awk 'NR==2 {printf "%.0f\\n", $4 * 1024}'`,
    'printf "@@WEIGHTS@@"',
    ...weights,
  ].join('\n')
  const result = await sshExec(host, command, REMOTE_PROBE_TIMEOUT_MS)
  if (result.code !== 0) {
    console.warn('[training]', `probe of ${host.id} failed:`, (result.stderr || result.stdout).trim().slice(-400))
    throw codedError('E_TRAINING_HOST', `连不上训练主机「${host.name}」。请检查网络和主机设置。`)
  }
  const number = (text: string): number | null => {
    const value = Number(text)
    return text && Number.isFinite(value) ? value : null
  }
  return {
    facts: {
      mac: /darwin/i.test(section(result.stdout, 'OS')),
      gpu: parseGpuRows(section(result.stdout, 'GPU'))[0] ?? null,
      ramBytes: number(section(result.stdout, 'RAM')),
    },
    freeBytes: number(section(result.stdout, 'DISK')),
    weights: section(result.stdout, 'WEIGHTS') === 'yes',
  }
}

async function remoteReadiness(settings: Settings, hostId: string): Promise<TrainingReadiness> {
  const host = sshHost(settings, hostId)
  const probe = await probeRemote(host)
  return assemble(
    hostId,
    probe.facts,
    // Nothing is downloaded to a host: the person points the host settings at the weights.
    { bundleId: BASE_DOWNLOAD, name: BASE_NAME, installed: probe.weights, missingBytes: 0 },
    trainerOf(remoteVersions(settings, hostId), prepareOf(hostId)),
    { path: host.trainerRoot, freeBytes: probe.freeBytes },
  )
}

export function trainingReadiness(hostId: string): Promise<TrainingReadiness> {
  const settings = getSettings()
  return hostId === 'local' ? localReadiness(settings) : remoteReadiness(settings, hostId)
}

async function broadcast(hostId: string): Promise<void> {
  try {
    emit(Events.trainingReadinessChanged, await trainingReadiness(hostId))
  } catch (error) {
    console.warn('[training]', 'readiness after a prepare step failed:', error instanceof Error ? error.message : error)
  }
}

const STEP_ERRORS: Record<TrainingPrepareStep, string> = {
  model: '基础模型没有下载完。检查网络后再点一次准备。',
  trainer: '训练器没有下载成功。检查网络后再点一次准备。',
  environment: '训练环境没有装好。检查网络后再点一次准备。',
}
export const WEIGHTS_MISSING = '这台主机上还没有找到 MOSS-Image Base 模型。在主机设置里填写它所在的文件夹后再试。'

/** Thrown from inside a step: carries which step failed, with the raw cause logged. */
function stepFailure(step: TrainingPrepareStep, cause: unknown): Error {
  console.warn('[training]', `prepare ${step} failed:`, cause instanceof Error ? cause.message : cause)
  return Object.assign(new Error(STEP_ERRORS[step]), { step })
}

async function downloadBase(settings: Settings): Promise<void> {
  try {
    const tasks = await installBundle(BASE_DOWNLOAD, settings)
    for (const task of tasks) {
      const done = await waitForDownload(task.id)
      if (done?.state !== 'done') throw new Error(done?.error ?? `download ${task.id} ended as ${done?.state ?? 'canceled'}`)
    }
  } catch (error) {
    throw stepFailure('model', error)
  }
}

/** The trainer's stable tag, else the newest commit of its default branch. */
async function localTrainer(settings: Settings, setStep: (step: TrainingPrepareStep) => void): Promise<void> {
  if ((await listTrainerVersions(settings)).some((version) => version.status === 'ok' && version.runtimeState === 'ready')) return
  setStep('trainer')
  let versionId: string
  try {
    const branches = await listTrainerBranches(settings)
    const branch = branches.find((item) => item.isDefault) ?? branches[0]
    if (!branch) throw new Error('no branch')
    const commit = (await trainerTagSha(settings)) ?? branch.sha
    versionId = (await createTrainerVersion(settings, { branch: branch.name, commit })).id
  } catch (error) {
    throw stepFailure('trainer', error)
  }
  setStep('environment')
  try {
    await installTrainerRuntime(settings, versionId)
  } catch (error) {
    throw stepFailure('environment', error)
  }
}

async function remoteTrainer(settings: Settings, hostId: string, setStep: (step: TrainingPrepareStep) => void): Promise<void> {
  if (remoteVersions(settings, hostId).some((version) => version.runtimeState === 'ready')) return
  setStep('trainer')
  let version: TrainerVersion
  try {
    const branches = await remoteBranches(settings, hostId)
    const branch = branches.find((item) => item.isStable) ?? branches.find((item) => item.isDefault) ?? branches[0]
    if (!branch) throw new Error('no branch')
    version = await remoteCreateVersion(settings, hostId, { branch: branch.name, commit: branch.sha })
  } catch (error) {
    throw stepFailure('trainer', error)
  }
  setStep('environment')
  try {
    await remoteInstallRuntime(settings, version)
  } catch (error) {
    throw stepFailure('environment', error)
  }
}

async function runPrepare(hostId: string, state: PrepareState): Promise<void> {
  const settings = getSettings()
  let downloading = false
  let trainerStep: TrainingPrepareStep | null = null
  const update = (): void => {
    state.step = downloading ? 'model' : trainerStep
    void broadcast(hostId)
  }
  const setStep = (step: TrainingPrepareStep): void => {
    trainerStep = step
    update()
  }
  const tasks: Array<Promise<void>> = []
  if (hostId === 'local') {
    if (!(await installedBaseBundle(settings))) {
      downloading = true
      update()
      tasks.push(
        downloadBase(settings).finally(() => {
          downloading = false
          update()
        }),
      )
    }
    tasks.push(localTrainer(settings, setStep))
  } else {
    sshHost(settings, hostId)
    tasks.push(remoteTrainer(settings, hostId, setStep))
  }
  const results = await Promise.allSettled(tasks)
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed) {
    const reason = failed.reason as { message?: string; step?: TrainingPrepareStep }
    state.error = reason.step ? (reason.message ?? STEP_ERRORS[reason.step]) : (reason.message ?? STEP_ERRORS.trainer)
    state.failedStep = reason.step ?? null
  } else if (hostId !== 'local' && !getTrainingHost(settings, hostId)?.weightsPath) {
    state.error = WEIGHTS_MISSING
  }
}

/** Starts preparing (once per host at a time) and answers the readiness at that moment. */
export async function prepareTraining(hostId: string): Promise<TrainingReadiness> {
  if (!prepareOf(hostId).running) {
    const state: PrepareState = { running: true, step: null, error: null, failedStep: null }
    prepares.set(hostId, state)
    void runPrepare(hostId, state)
      .catch((error: unknown) => {
        console.warn('[training]', 'prepare failed:', error instanceof Error ? error.message : error)
        // Our own coded errors are already written for the person.
        state.error = errorCode(error) && error instanceof Error ? error.message : STEP_ERRORS.trainer
      })
      .finally(() => {
        state.running = false
        state.step = null
        void broadcast(hostId)
      })
  }
  return trainingReadiness(hostId)
}
