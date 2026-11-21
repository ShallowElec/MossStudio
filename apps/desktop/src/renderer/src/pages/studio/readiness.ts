import type {
  CanvasAdapter,
  AdapterEntry,
  Catalog,
  EngineFeatures,
  EngineReadiness,
  GpuInventoryDevice,
  ModelBundle,
  ModelEntry,
  ProjectCanvas,
  RemoteHostBackend,
} from '@shared/types'
import { bundleGpusProblem, bundleWeightProblem, isFileBundle, isLocalOnlyBundle } from '@shared/bundleFit'
import { adapterStatuses, normalizeCanvasAdapters } from '@shared/adapters'
import { CLI_ENGINE_LABEL, cliBundleProblem } from '@shared/cliEngine'
import { lostFile, lostFileText } from '@shared/modelImport'
import { compileCanvasPrompt, type CompiledPrompt, type LoraTriggerProfiles } from './prompt'
import { isWorkerDaemonHost, missingWorkerAdapters, type WorkerAdapterEntry } from './remoteWorkerLoras'

/** Problems with a canvas's pictures and sampling choices (see jobInputs.ts). */
export type InputBlockerId = 'input-source' | 'input-adapter' | 'input-unsupported' | 'input-invalid'

/**
 * What stands between the user and the 生成 button. Only real blockers are
 * listed; each one says what is wrong and, when the fix lives elsewhere, where
 * to go. Pure so every combination is unit tested.
 */

export interface Blocker {
  id:
    | 'update-required'
    | 'model-none'
    | 'model-missing'
    | 'model-incomplete'
    | 'model-file'
    | 'model-engine'
    | 'engine'
    | 'remote-path'
    | 'adapters'
    | 'remote-adapters'
    | 'lora-unsupported'
    | 'prompt'
    | InputBlockerId
  message: string
  /** Where the fix lives; `opens: 'update'` opens the title bar update popover instead of going to `to`. */
  action?: { label: string; to: string; opens?: 'update' }
}

/** A bundle is usable when every file it needs is installed. */
export function bundleInstalled(bundle: ModelBundle, models: readonly ModelEntry[]): boolean {
  const ids = [bundle.components.dit, bundle.components.textEncoder, bundle.components.vae, bundle.support].filter(Boolean)
  return ids.every((id) => models.some((model) => model.id === id && model.installed))
}

export function installedBundles(catalog: Pick<Catalog, 'bundles' | 'models'> | null | undefined): ModelBundle[] {
  if (!catalog) return []
  return catalog.bundles.filter((bundle) => bundleInstalled(bundle, catalog.models))
}

export interface BundleChoice {
  /** The bundle this canvas runs with, if one can be resolved. */
  bundle: ModelBundle | null
  installed: boolean
  /** The canvas names a bundle the catalog no longer has. */
  unavailable: boolean
}

/**
 * The model a canvas runs with: the one it names, otherwise the user's last
 * pick, otherwise the recommended installed one, otherwise the first installed.
 */
export function resolveBundle(
  catalog: Pick<Catalog, 'bundles' | 'models'> | null | undefined,
  requestedId: string | undefined,
  preferredId?: string | null,
): BundleChoice {
  if (!catalog) return { bundle: null, installed: false, unavailable: false }
  if (requestedId) {
    const bundle = catalog.bundles.find((item) => item.id === requestedId) ?? null
    if (!bundle) return { bundle: null, installed: false, unavailable: true }
    return { bundle, installed: bundleInstalled(bundle, catalog.models), unavailable: false }
  }
  const installed = installedBundles(catalog)
  const bundle = installed.find((item) => item.id === preferredId) ?? installed.find((item) => item.recommended) ?? installed[0] ?? null
  return { bundle, installed: Boolean(bundle), unavailable: false }
}

export interface ReadinessInput {
  canvas: Pick<ProjectCanvas, 'prompt' | 'summary' | 'layers' | 'width' | 'height' | 'adapters'> | null
  catalog: (Pick<Catalog, 'bundles' | 'models'> & { adapters?: readonly AdapterEntry[] }) | null | undefined
  bundle: BundleChoice
  /** Local engine state; null while it is still being read (never a blocker then). */
  engine: EngineReadiness | null
  /** True once first-run setup has been completed or dismissed. */
  setupDone: boolean
  /** The SSH machine this run goes to, when remote hosts are enabled and one is picked. */
  remote: { name: string; modelPath?: string; remoteBackend?: RemoteHostBackend } | null
  /** What is wrong with the canvas's pictures and sampling (from `resolveJobInputs`). */
  inputBlockers?: readonly Blocker[]
  /** The app update state: this version may be too old to generate (main refuses it too). */
  update?: { supported: boolean; required: boolean; minimumVersion: string | null } | null
  /** What the engine this run goes to can do; undefined while reading, null when none is usable. */
  features?: EngineFeatures | null
  /** The GPUs of this computer the run may use (empty or absent while unknown). */
  gpus?: readonly GpuInventoryDevice[]
  /** Which of them run a CLI engine (兼容模式 / AMD 原生). */
  cliGpus?: ReadonlySet<string>
  /** The LoRA the picked Worker host has (`Ipc.remoteWorkerLoras`); null or absent while unknown. */
  workerAdapters?: readonly WorkerAdapterEntry[] | null
  /** Remembered LoRA profiles: automatic trigger words go into the compiled prompt. */
  loraProfiles?: LoraTriggerProfiles
  /** The canvas's LoRA with those of its 风格, for the trigger words; the canvas's own when absent. */
  promptAdapters?: readonly CanvasAdapter[]
}

/** Bundle ids of the models a connected Worker daemon serves (see models.ts in main). */
export const REMOTE_WORKER_BUNDLE_PREFIX = 'remote-worker:'

/**
 * A run that goes to a Worker daemon: either the host is one, or the model is
 * one a connected Worker serves. The Worker owns the model files, the engine
 * and LoRA, so the checks about this computer's engine and the SSH model
 * location do not apply.
 */
export function isWorkerRun(
  bundle: Pick<ModelBundle, 'id'> | null | undefined,
  remote: { remoteBackend?: RemoteHostBackend } | null | undefined,
): boolean {
  return Boolean(bundle?.id.startsWith(REMOTE_WORKER_BUNDLE_PREFIX)) || remote?.remoteBackend === 'worker-daemon'
}

export interface Readiness {
  blockers: Blocker[]
  prompt: CompiledPrompt | null
}

/** The reason generation is blocked by a required update, or null when it is not. */
export function updateRequiredReason(update: ReadinessInput['update']): string | null {
  if (!update?.required) return null
  return update.minimumVersion ? `必须更新到 ${update.minimumVersion} 才能继续生成` : '必须更新后才能继续生成'
}

export function deriveReadiness(input: ReadinessInput): Readiness {
  const blockers: Blocker[] = []
  const toModels = { label: '去下载', to: '/models' }
  const updateReason = updateRequiredReason(input.update)
  if (input.update && updateReason) {
    blockers.push({
      id: 'update-required',
      message: updateReason,
      // A copy that cannot update itself has no popover to open: 设置 says why and links the download.
      action: input.update.supported
        ? { label: '更新', to: '/settings/updates', opens: 'update' }
        : { label: '查看', to: '/settings/updates' },
    })
  }
  // A Worker host brings its own model: nothing on this computer has to be downloaded.
  const workerHost = isWorkerDaemonHost(input.remote)
  if (input.catalog && !workerHost) {
    if (input.bundle.unavailable) {
      blockers.push({
        id: 'model-missing',
        message: '这个画面用的模型已经不在模型库里，请换一个模型',
        action: installedBundles(input.catalog).length ? undefined : toModels,
      })
    } else if (!input.bundle.bundle) {
      blockers.push({ id: 'model-none', message: '还没有可用的模型', action: toModels })
    } else if (!input.bundle.installed) {
      // The person's own file that moved is found again, not downloaded.
      const lost = lostFile(input.bundle.bundle, input.catalog.models)
      blockers.push(
        lost
          ? {
              id: 'model-file',
              message: lostFileText(input.bundle.bundle.name, lost),
              action: { label: '重新找到…', to: `/models?bundle=${encodeURIComponent(input.bundle.bundle.id)}` },
            }
          : { id: 'model-incomplete', message: `「${input.bundle.bundle.name}」还没有下载完`, action: toModels },
      )
    }
  }

  // No engine loads an fp16 main model; the checks below would only add a second reason. A moved file already said why.
  const lostOwn = input.catalog && input.bundle.bundle && !workerHost ? lostFile(input.bundle.bundle, input.catalog.models) : null
  const weights =
    input.catalog && input.bundle.bundle && !lostOwn && !workerHost ? bundleWeightProblem(input.bundle.bundle, input.catalog.models) : null
  if (weights) blockers.push({ id: 'model-engine', message: `「${input.bundle.bundle!.name}」${weights}，请换一个模型`, action: toModels })

  const worker = isWorkerRun(input.bundle.bundle, input.remote)
  // A CLI engine (兼容模式 / AMD 原生) reads a bf16 bundle folder only.
  const cli = input.remote || worker ? undefined : input.features?.cli
  if (!weights && cli && input.catalog && input.bundle.bundle && input.bundle.installed) {
    const problem = cliBundleProblem(cli, input.bundle.bundle, input.catalog.models)
    if (problem) blockers.push({ id: 'model-engine', message: problem, action: toModels })
  }
  // Single files load only on this computer; some quantized models need a particular GPU.
  const picked = !weights && !worker && input.catalog && input.bundle.installed ? input.bundle.bundle : null
  if (picked && input.catalog) {
    const problem = input.remote
      ? isLocalOnlyBundle(picked, input.catalog.models)
        ? '只能在这台电脑上运行，在其他电脑上请换成官方模型'
        : null
      : cli
        ? null
        : bundleGpusProblem(picked, input.gpus ?? [], { cliGpus: input.cliGpus, files: isFileBundle(picked, input.catalog.models) })
    if (problem)
      blockers.push({
        id: 'model-engine',
        message: input.remote ? `「${picked.name}」${problem}` : `「${picked.name}」${problem}，请换一个模型`,
      })
  }

  // A Worker reports its own engine and model problems when the job starts there.
  if (input.remote && !worker) {
    if (!input.remote.modelPath?.trim()) {
      blockers.push({
        id: 'remote-path',
        message: `「${input.remote.name}」还没有设置模型位置`,
        action: { label: '去设置', to: '/settings/devices' },
      })
    }
  } else if (!input.remote && !worker && input.engine && input.engine.state !== 'ready') {
    const target = input.setupDone ? '/settings/devices' : '/setup'
    if (input.engine.installing) {
      const percent = Math.max(0, Math.min(100, Math.round(input.engine.installing.percent)))
      blockers.push({ id: 'engine', message: `引擎正在安装 · ${percent}%`, action: { label: '查看', to: target } })
    } else {
      blockers.push({ id: 'engine', message: '引擎未就绪', action: { label: input.setupDone ? '去设置' : '去准备', to: target } })
    }
  }

  const adapters = normalizeCanvasAdapters(input.canvas?.adapters)
  // Until the library has loaded nothing is known to be missing.
  // On a Worker host its own list decides, never this computer's library.
  const missing = workerHost
    ? missingWorkerAdapters(adapters, input.workerAdapters).map((adapter) => ({
        name: input.workerAdapters?.find((entry) => entry.id === adapter.id)?.name ?? adapter.path ?? adapter.id,
      }))
    : input.catalog
      ? adapterStatuses(adapters, input.catalog.adapters).filter((item) => !item.installed)
      : []
  if (missing.length) {
    const names = missing.map((item) => `「${item.name}」`).join('')
    blockers.push(
      workerHost
        ? { id: 'adapters', message: `「${input.remote!.name}」上没有登记 LoRA ${names}，请移除或在 LoRA 列表里登记` }
        : { id: 'adapters', message: `LoRA ${names}找不到了，请移除或重新安装`, action: { label: '去模型库', to: '/models' } },
    )
  }
  // A Worker applies LoRA itself.
  if (!worker && input.remote && adapters.length) {
    blockers.push({ id: 'remote-adapters', message: '在其他电脑上运行时暂不支持 LoRA，请移除 LoRA 或改回这台电脑' })
  } else if (!worker && adapters.length && input.features && !input.features.lora) {
    const engine = input.features.cli ? `${CLI_ENGINE_LABEL[input.features.cli]}引擎` : '这台设备上的引擎'
    blockers.push({ id: 'lora-unsupported', message: `${engine}不支持 LoRA，请移除 LoRA 后再生成` })
  }

  if (input.canvas) blockers.push(...(input.inputBlockers ?? []))

  const prompt = input.canvas
    ? compileCanvasPrompt({ ...input.canvas, adapters: [...(input.promptAdapters ?? input.canvas.adapters ?? [])] }, input.loraProfiles)
    : null
  if (prompt && !prompt.ok) blockers.push({ id: 'prompt', message: prompt.errors[0] ?? '描述还不完整' })

  return { blockers, prompt }
}

/**
 * Why something that needs the engine (adding pictures, a mask, a wire) cannot
 * be done right now, or null when it can. Worded from the same readiness the
 * 生成 footer shows, so the two never disagree (e.g. the engine is still
 * installing, not missing). `action` is what waits, e.g. "添加图片".
 */
export function engineUnavailableReason(
  features: EngineFeatures | null | undefined,
  blockers: readonly Blocker[],
  action: string,
): string | null {
  if (features === undefined) return '正在读取引擎支持的功能…'
  if (features !== null) return null
  const engine = blockers.find((blocker) => blocker.id === 'engine' || blocker.id === 'remote-path')
  return engine ? `${engine.message}，就绪后才能${action}` : `没有可用的引擎，暂时不能${action}`
}

/** Why the 输入 section cannot add pictures right now, or null when it can. */
export function inputsUnavailableReason(features: EngineFeatures | null | undefined, blockers: readonly Blocker[]): string | null {
  return engineUnavailableReason(features, blockers, '添加图片')
}

export interface RerunCheck {
  ok: boolean
  reason?: string
}

/**
 * Whether a card can run again (or once more, queued behind its own runs). A
 * canvas made only of regions has an empty `prompt` but a valid layout, so
 * eligibility is the compiled prompt, never the raw text field. `blocked`: a
 * run in its lineage started from another canvas is going (`blockedCanvasIds`);
 * `full`: `MAX_QUEUED_RUNS` are already waiting.
 */
export function rerunEligibility(
  canvas: Pick<ProjectCanvas, 'id' | 'prompt' | 'summary' | 'layers' | 'width' | 'height'>,
  state: { blocked: boolean; full?: boolean; inputDrawing?: string | null; update?: ReadinessInput['update'] },
): RerunCheck {
  // Main would refuse it anyway (E_UPDATE_REQUIRED); say so on the button instead.
  const updateReason = updateRequiredReason(state.update)
  if (updateReason) return { ok: false, reason: updateReason }
  if (state.blocked) return { ok: false, reason: '这个画面或它的来源正在生成' }
  // A wired picture still being drawn (`inputStillDrawing`): the run would be refused for it.
  if (state.inputDrawing) return { ok: false, reason: state.inputDrawing }
  if (state.full) return { ok: false, reason: '排队已满' }
  const compiled = compileCanvasPrompt(canvas)
  if (!compiled.ok) return { ok: false, reason: compiled.errors[0] }
  return { ok: true }
}
