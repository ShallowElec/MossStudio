import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PackageInstallProgress, Settings, TrainerRuntimeInfo, TrainerVersion } from '@shared/types'
import { run } from '../lib/run'
import { installPackages } from './packageInstall'
import { nvidiaDriver, type NvidiaDriver } from './runtimes'
import { allRemoteVersions } from './remoteTrainer'
import { checkBareMirror } from './gitHealth'
import { hasUv, parseTrainerDeps, pickPython, venvPython } from './trainerEnv'
import {
  createTrainerWorktree,
  ensureTrainerMirror,
  isTrainerDirty,
  listTrainerCommits,
  removeTrainerWorktree,
  trainerCommitExists,
  trainerMirror,
  trainerRuntimeDir,
  trainerTagSha,
  trainerVersionDir,
  trainerVersionsDir,
} from './trainerGit'

function versionFile(settings: Settings, id: string): string {
  return join(trainerVersionDir(settings, id), 'trainer.json')
}

function runtimeDir(settings: Settings, id: string): string {
  return trainerRuntimeDir(settings, id)
}

function runtimeFile(settings: Settings, id: string): string {
  return join(runtimeDir(settings, id), 'runtime.json')
}

function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8)
}

async function readRuntime(settings: Settings, id: string): Promise<TrainerRuntimeInfo | null> {
  try {
    return JSON.parse(await readFile(runtimeFile(settings, id), 'utf8')) as TrainerRuntimeInfo
  } catch {
    return null
  }
}

async function writeRuntime(settings: Settings, runtime: TrainerRuntimeInfo): Promise<void> {
  await mkdir(runtimeDir(settings, runtime.id), { recursive: true })
  await writeFile(runtimeFile(settings, runtime.id), JSON.stringify(runtime, null, 2), 'utf8')
}

async function readVersion(settings: Settings, id: string): Promise<TrainerVersion | null> {
  try {
    const raw = JSON.parse(await readFile(versionFile(settings, id), 'utf8')) as TrainerVersion
    if (!raw.hostId) {
      raw.hostId = 'local'
      raw.hostName = '本机'
    }
    return raw
  } catch {
    return null
  }
}

async function writeVersion(settings: Settings, version: TrainerVersion): Promise<void> {
  await mkdir(version.path, { recursive: true })
  await writeFile(versionFile(settings, version.id), JSON.stringify(version, null, 2), 'utf8')
}

async function syncVersion(settings: Settings, version: TrainerVersion): Promise<TrainerVersion> {
  if (!existsSync(version.path)) {
    version.status = 'missing'
    return version
  }
  version.dirty = await isTrainerDirty(version.path)
  version.status = 'ok'
  if (version.runtimeId) {
    const runtime = await readRuntime(settings, version.runtimeId)
    // An environment with the wrong PyTorch build (CPU on an NVIDIA machine) is installed again.
    version.runtimeState = runtime && (await torchCurrent(settings, runtime)) ? runtime.state : 'missing'
  }
  return version
}

const TORCH_WHEELS = 'https://download.pytorch.org/whl'
/** PyTorch's CUDA wheel indexes, newest first, with the oldest driver each runs on (Windows; Linux needs a little less). */
const CUDA_INDEXES: Array<{ index: string; driver: number }> = [
  { index: `${TORCH_WHEELS}/cu130`, driver: 580 },
  { index: `${TORCH_WHEELS}/cu128`, driver: 570 },
  { index: `${TORCH_WHEELS}/cu126`, driver: 560 },
]

/**
 * Where the trainer's PyTorch comes from, best first. Empty: plain PyPI,
 * whose Linux wheel already uses CUDA and whose macOS wheel uses MPS. Only
 * Windows needs an index of its own, since PyPI's Windows wheel is CPU only.
 * Several CUDA indexes are offered because each carries a different range of
 * PyTorch versions (cu128 stops at 2.11) and the trainer pins one: install
 * takes the first that has it. `null` driver: nvidia-smi did not answer.
 */
export function torchIndexes(
  settings: Pick<Settings, 'torchIndex' | 'torchBackend'>,
  driver: NvidiaDriver | null,
  platform: NodeJS.Platform,
): string[] {
  const custom = settings.torchIndex?.trim()
  if (custom) return [custom.replace(/\/$/, '')]
  if (settings.torchBackend === 'cpu') return [`${TORCH_WHEELS}/cpu`]
  const cuda = (): string[] => {
    // A driver of unknown age gets the oldest build first, the one most drivers run; one too old for any
    // gets that one alone (CUDA's minor-version compatibility runs it on older 12.x drivers).
    const major = driver?.major
    if (major == null) return CUDA_INDEXES.map((item) => item.index).reverse()
    const fits = CUDA_INDEXES.filter((item) => major >= item.driver).map((item) => item.index)
    return fits.length ? fits : [CUDA_INDEXES.at(-1)!.index]
  }
  if (settings.torchBackend === 'cuda') return platform === 'darwin' ? [] : cuda()
  if (platform !== 'win32' || driver?.present === false) return []
  return cuda()
}

/**
 * Whether an environment's PyTorch is a build this machine should use.
 * Environments made before the index was recorded came from plain PyPI,
 * whose Windows wheel is CPU only. `wanted` undefined: it cannot be told, so
 * nothing is reinstalled.
 */
export function torchBuildCurrent(
  recorded: string | null | undefined,
  wanted: readonly string[] | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (wanted === undefined) return true
  if (recorded === undefined) return !(platform === 'win32' && wanted.some((index) => index.includes('/cu')))
  // Nothing particular wanted (PyPI): a CUDA build also runs on the CPU, so it is never worth a download.
  if (wanted.length === 0) return recorded === null || recorded.includes('/cu')
  return recorded !== null && wanted.includes(recorded)
}

async function wantedTorchIndexes(settings: Settings): Promise<string[] | undefined> {
  const driver = await nvidiaDriver()
  // Without an answer from nvidia-smi on Windows (auto), the build cannot be told.
  if (!driver && process.platform === 'win32' && settings.torchBackend === 'auto' && !settings.torchIndex?.trim()) return undefined
  return torchIndexes(settings, driver, process.platform)
}

async function torchCurrent(settings: Settings, runtime: TrainerRuntimeInfo): Promise<boolean> {
  // Only a finished environment is judged; one being made has not chosen its build yet.
  if (runtime.state !== 'ready') return true
  return torchBuildCurrent(runtime.torchIndex, await wantedTorchIndexes(settings), process.platform)
}

export async function listAllTrainerVersions(settings: Settings): Promise<TrainerVersion[]> {
  const local = await listTrainerVersions(settings)
  return [...local, ...allRemoteVersions(settings)]
}

export async function findTrainerVersion(settings: Settings, id: string): Promise<TrainerVersion | null> {
  const local = await listTrainerVersions(settings)
  return local.find((item) => item.id === id) ?? allRemoteVersions(settings).find((item) => item.id === id) ?? null
}

export async function listTrainerVersions(settings: Settings): Promise<TrainerVersion[]> {
  const dir = trainerVersionsDir(settings)
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const out: TrainerVersion[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const version = await readVersion(settings, entry.name)
      if (version) out.push(await syncVersion(settings, version))
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  } catch {
    return []
  }
}

export interface CreateTrainerVersionInput {
  branch: string
  commit: string
  name?: string
}

export async function createTrainerVersion(settings: Settings, input: CreateTrainerVersionInput): Promise<TrainerVersion> {
  await ensureTrainerMirror(settings)
  if (!(await trainerCommitExists(settings, input.commit))) throw new Error('训练器提交不存在，请先拉取仓库')
  const commits = await listTrainerCommits(settings, input.branch, 200)
  const commit = commits.find((item) => item.sha === input.commit)
  const id = `kohaku-${input.commit.slice(0, 7)}`
  const existing = await readVersion(settings, id)
  if (existing) return syncVersion(settings, existing)
  const path = trainerVersionDir(settings, id)
  await createTrainerWorktree(settings, input.commit, path)
  const stableSha = await trainerTagSha(settings)
  const version: TrainerVersion = {
    id,
    hostId: 'local',
    hostName: '本机',
    name: input.name?.trim() || `Kohaku ${input.commit.slice(0, 7)}`,
    branch: input.branch,
    commit: input.commit,
    shortCommit: commit?.short ?? input.commit.slice(0, 7),
    commitDate: commit?.date ?? new Date().toISOString(),
    subject: commit?.subject ?? '',
    author: commit?.author ?? '',
    channel: stableSha === input.commit ? 'stable' : 'experimental',
    path,
    runtimeId: '',
    runtimeState: 'missing',
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    dirty: false,
    status: 'ok',
  }
  await writeVersion(settings, version)
  return version
}

export async function removeTrainerVersion(settings: Settings, id: string): Promise<void> {
  const version = await readVersion(settings, id)
  if (!version) return
  const others = (await listTrainerVersions(settings)).filter((item) => item.id !== id)
  await removeTrainerWorktree(settings, version.path)
  await rm(trainerVersionDir(settings, id), { recursive: true, force: true })
  if (version.runtimeId && !others.some((item) => item.runtimeId === version.runtimeId)) {
    await rm(runtimeDir(settings, version.runtimeId), { recursive: true, force: true })
  }
}

export async function ensureTrainerRuntime(settings: Settings, versionId: string): Promise<TrainerRuntimeInfo> {
  const version = await readVersion(settings, versionId)
  if (!version) throw new Error('训练版本不存在')
  if (!existsSync(version.path)) throw new Error('训练版本目录不存在')
  const deps = parseTrainerDeps(version.path)
  const python = await pickPython(settings)
  const torchIndexes = (await wantedTorchIndexes(settings)) ?? null
  const lockHash = hash(
    JSON.stringify({ python: python.version, platform: process.platform, arch: process.arch, deps: [...deps].sort(), torchIndexes }),
  )
  if (version.runtimeId) {
    const existing = await readRuntime(settings, version.runtimeId)
    // A finished environment stays while its PyTorch build fits. An unfinished one is taken up again only when it was
    // made for the same sources: pip skips a torch that is already there, whatever index it came from.
    const fits = existing?.state === 'ready' ? await torchCurrent(settings, existing) : existing?.lockHash === lockHash
    if (existing && existsSync(venvPython(existing.path)) && fits) return existing
  }
  const runtimeId = `tr-py${python.version.replace(/\./g, '')}-${lockHash}`
  const existing = await readRuntime(settings, runtimeId)
  if (existing) {
    version.runtimeId = runtimeId
    version.runtimeState = existing.state
    await writeVersion(settings, version)
    return existing
  }
  const target = runtimeDir(settings, runtimeId)
  await mkdir(target, { recursive: true })
  const uv = await hasUv()
  const result = uv
    ? await run('uv', ['venv', target, '--python', python.path], { timeoutMs: 180_000 })
    : await run(python.path, ['-m', 'venv', target], { timeoutMs: 180_000 })
  if (result.code !== 0) throw new Error(`创建训练环境失败：${result.stderr.slice(-500)}`)
  const runtime: TrainerRuntimeInfo = {
    id: runtimeId,
    versionId,
    path: target,
    python: venvPython(target),
    pythonVersion: python.version,
    lockHash,
    state: 'created',
    deps,
    createdAt: new Date().toISOString(),
  }
  await writeRuntime(settings, runtime)
  version.runtimeId = runtimeId
  version.runtimeState = 'created'
  await writeVersion(settings, version)
  return runtime
}

/** The trainer's PyTorch requirements (torch, and torchvision or torchaudio when it lists them); plain torch when it names none. */
export function torchRequirements(deps: readonly string[]): string[] {
  const wanted = deps.filter((dep) => /^torch(?:vision|audio)?(?:\s|[<>=!~[;]|$)/.test(dep))
  return wanted.length ? wanted : ['torch']
}

/**
 * Installs the trainer into its environment. PyTorch comes first from the
 * index for this machine (CUDA wheels with an NVIDIA card: PyPI's Windows
 * wheel is CPU only), then the trainer itself, which finds torch satisfied.
 */
export async function installTrainerRuntime(
  settings: Settings,
  versionId: string,
  onProgress?: (progress: PackageInstallProgress) => void,
): Promise<TrainerRuntimeInfo> {
  const before = await readVersion(settings, versionId)
  if (!before) throw new Error('训练版本不存在')
  const replaced = before.runtimeId
  const runtime = await ensureTrainerRuntime(settings, versionId)
  const version = (await readVersion(settings, versionId))!
  runtime.state = 'installing'
  await writeRuntime(settings, runtime)
  version.runtimeState = 'installing'
  await writeVersion(settings, version)
  const index = settings.pipIndex ?? 'https://pypi.org/simple'
  const uv = await hasUv()
  const install = (indexUrl: string, packages: string[]) =>
    installPackages({ python: runtime.python, uv, indexUrl, packages, timeoutMs: 3_600_000, onProgress })
  const fail = async (message: string): Promise<never> => {
    runtime.state = 'error'
    await writeRuntime(settings, runtime)
    version.runtimeState = 'error'
    await writeVersion(settings, version)
    throw new Error(message)
  }

  // PyTorch first, from the first index that has a version the trainer accepts.
  const indexes = (await wantedTorchIndexes(settings)) ?? torchIndexes(settings, { present: true, major: null }, process.platform)
  let torchIndex: string | null = null
  for (const candidate of indexes) {
    const result = await install(candidate, torchRequirements(runtime.deps))
    if (result.code === 0) {
      torchIndex = candidate
      break
    }
    if (!versionUnavailable(`${result.stdout}\n${result.stderr}`) || candidate === indexes.at(-1)) {
      await fail(`PyTorch 安装失败（${candidate}）：${result.stderr.slice(-1200)}`)
    }
  }
  const result = await install(index, ['-e', version.path])
  if (result.code !== 0) await fail(`训练依赖安装失败：${result.stderr.slice(-1200)}`)
  runtime.torchIndex = torchIndex
  runtime.state = 'ready'
  await writeRuntime(settings, runtime)
  version.runtimeState = 'ready'
  await writeVersion(settings, version)
  if (replaced && replaced !== runtime.id) await dropUnusedRuntime(settings, replaced)
  return runtime
}

/** pip and uv saying the index has no version that meets the requirement (as opposed to a network or build error). */
export function versionUnavailable(output: string): boolean {
  // pip says the same when it could not reach the index at all, then with no versions listed.
  if (/\(from versions: none\)/.test(output)) return false
  return /No matching distribution found|Could not find a version that satisfies|No solution found when resolving|there is no version of torch|only torch[^\n]* (?:is|are) available/i.test(
    output,
  )
}

/** An environment replaced by a new one (another PyTorch build) takes gigabytes; it goes once no version uses it. */
async function dropUnusedRuntime(settings: Settings, runtimeId: string): Promise<void> {
  const versions = await listTrainerVersions(settings)
  if (versions.some((item) => item.runtimeId === runtimeId)) return
  await rm(runtimeDir(settings, runtimeId), { recursive: true, force: true }).catch(() => undefined)
}

export async function trainerDoctor(settings: Settings, versionId: string): Promise<{ ok: boolean; output: string }> {
  const version = await readVersion(settings, versionId)
  if (!version) throw new Error('训练版本不存在')
  const runtime = version.runtimeId ? await readRuntime(settings, version.runtimeId) : null
  if (!runtime || !existsSync(runtime.python)) {
    throw new Error('训练环境尚未创建，请先安装环境')
  }
  const bin =
    process.platform === 'win32' ? join(runtime.path, 'Scripts', 'kohakumoss-doctor.exe') : join(runtime.path, 'bin', 'kohakumoss-doctor')
  const command = existsSync(bin) ? bin : runtime.python
  const args = existsSync(bin) ? [] : ['-m', 'kohakumoss.cli.doctor']
  const result = await run(command, args, { cwd: version.path, timeoutMs: 120_000 })
  const output = `${result.stdout}${result.stderr}`.trim()
  return { ok: result.code === 0, output: output.slice(-12000) }
}

export async function trainerMirrorInfo(settings: Settings): Promise<{ ready: boolean; path: string }> {
  const mirror = trainerMirror(settings)
  const health = await checkBareMirror(mirror)
  return { ready: health.healthy, path: mirror }
}

export async function trainerRuntimeSummary(settings: Settings, versionId: string): Promise<TrainerRuntimeInfo | null> {
  const version = await readVersion(settings, versionId)
  if (!version?.runtimeId) return null
  return readRuntime(settings, version.runtimeId)
}
