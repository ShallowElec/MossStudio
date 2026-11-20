/**
 * The mutable state behind the mock backend, plus named starting scenarios.
 *
 * A scenario is plain data: handlers in ./index.ts read and write this state, so
 * a test changes what the "main process" knows by editing `backend.state`.
 */
import type { MangaSeries } from '@shared/manga/model'
import type { AiConversationInfo, AiProviderInfo, AiToolCall } from '@shared/ai'
import type { GbcJobSnapshot, GbcParseResult, GbcStatus } from '@shared/gbc'
import type { UpdaterState } from '@shared/update'
import { cliEngineFeatures } from '@shared/cliEngine'
import type { EngineAssetList, EngineMachine } from '@shared/engineChoice'
import { RELEASE_220, inventoryDevicesFor, machineFixture, type MachineName } from './machines'
import type {
  Catalog,
  Diagnostic,
  DownloadTask,
  EngineReadiness,
  EnvReport,
  GalleryDetail,
  GalleryItem,
  GbcVersion,
  GpuInventorySnapshot,
  JobLogLine,
  JobRecord,
  LaunchDevice,
  LaunchRow,
  LocalEngineVersion,
  ManagedHost,
  MossInferDownloadState,
  MossInferRelease,
  ControlAdapterEntry,
  EngineFeatures,
  ModelImportState,
  ProjectDocument,
  Settings,
  TrainerVersion,
} from '@shared/types'
import {
  FIXTURE_MODELS_PATH,
  FIXTURE_NOW,
  GiB,
  SFT_BUNDLE_IDS,
  catalogFixture,
  diagnosticFixture,
  importFixtures,
  movedOwnFileFixture,
  engineDownloadFixture,
  engineFeaturesFixture,
  engineReleaseFixture,
  engineMissingFixture,
  engineReadyFixture,
  engineVersionFixture,
  envReportFixture,
  galleryItemFixture,
  gbcParseFixture,
  gbcStatusFixture,
  GPU_RTX_5090,
  gpuDeviceFixture,
  gpuInventoryFixture,
  jobFixture,
  launchDeviceFixture,
  settingsFixture,
  sshHostFixture,
  trainerVersionFixture,
  updateAvailableFixture,
  updaterStateFixture,
} from './fixtures'
import { installStateFixture, type MockInstallState } from './install'
import type { MockImportFile } from './modelImport'
import { combinationBundle } from '@shared/modelCombos'
import {
  trainingBlockedFixture,
  trainingNotPreparedFixture,
  trainedAdapterFixture,
  trainingStateFixture,
  trainingsFixture,
  type MockTrainingState,
} from './training'

export interface MockBackendState {
  /** Shared model folders (ComfyUI and others): whether their files can be read, and whether 自动扫描 fails. */
  sharedModelDirectory?: { available: boolean; failRefresh?: boolean }
  settings: Settings
  env: EnvReport | null
  /** The update runtime (main/update); handlers keep it in step like main does. */
  update: UpdaterState
  catalog: Catalog
  downloads: DownloadTask[]
  jobs: JobRecord[]
  jobLogs: Record<string, JobLogLine[]>
  diagnostics: Diagnostic[]
  devices: LaunchDevice[]
  launchRows: LaunchRow[]
  gpuInventory: GpuInventorySnapshot
  engineReadiness: EngineReadiness
  engineVersions: LocalEngineVersion[]
  engineDownload: MossInferDownloadState | null
  engineReleases: MossInferRelease[]
  trainerVersions: TrainerVersion[]
  hosts: ManagedHost[]
  gallery: GalleryItem[]
  projects: ProjectDocument[]
  /** 漫画 series (manga:*); a new one also gets a backing project in `projects`, as main does. */
  manga: MangaSeries[]
  /** Answers ai:complete gives, in order (storyboard, memory); empty = the request fails. */
  aiCompletions: string[]
  /** What 选择图片 (dialog:pick-images) returns. */
  pickedImages: string[]
  aiProviders: AiProviderInfo[]
  conversations: AiConversationInfo[]
  /**
   * The tool calls the next ai:chat makes before it replies, run in the window
   * like main runs them (Events.aiToolCall, answered through ai:tool-result).
   * Empty = a plain text reply.
   */
  aiTurn: Array<Pick<AiToolCall, 'name' | 'arguments'>>
  /** 导入模型: what the engine says each path is (./modelImport.ts); a path not listed is not a model file. */
  importFiles: Record<string, MockImportFile>
  /** What 选择文件… / 选择文件夹… (and 重新找到…) pick; null = the dialog is canceled. */
  importPick: string[] | null
  /** Keep the files 正在识别 until `finishImport()`, to see the sheet while the engine checks them. */
  importHold: boolean
  /** The import running or last finished (models:import-state). */
  modelImport: ModelImportState | null
  /** What the engine's machine probe found (engine:plan runs the real chooser over it). */
  engineMachine: EngineMachine
  /** The release engine:plan plans against. */
  engineAssets: EngineAssetList
  /** What `engine:features` answers; null = no usable engine. */
  engineFeatures: EngineFeatures | null
  controlAdapters: ControlAdapterEntry[]
  /** Setup and uninstall windows (see ./install.ts). */
  install: MockInstallState
  /** System memory app:info reports (os.totalmem). */
  systemMemoryBytes: number
  /** Free space models:space reports for a models folder; a folder not listed has plenty. */
  diskFree: Record<string, number>
  /** 训练: readiness, the trainings and their pictures and samples (see ./training.ts). */
  training: MockTrainingState
  /** 看图拆区域: whether GBC runs, its versions, and what reading a picture finds. */
  gbc: {
    status: GbcStatus
    versions: GbcVersion[]
    parse: GbcParseResult
    job: GbcJobSnapshot | null
    /** How long 安装 stays on its package download before it is done (0: at once). */
    setupMs?: number
  }
}

export type ScenarioName =
  | 'firstRun'
  | 'sharedModelDirectory'
  | 'noGpu'
  | 'engineInstalling'
  | 'engineInstalledModelMissing'
  | 'modelPartiallyDownloaded'
  | 'ready'
  | 'jobFailure'
  | 'updateAvailable'
  | 'remoteHost'
  | 'modelMissingRtx50'
  | 'modelImport'
  | 'modelFileMoved'
  | MachineScenario
  | 'vulkanOnly'
  | 'lowMemory'
  | 'lowDisk'
  | 'trainingNotPrepared'
  | 'trainingBlocked'
  | 'trainings'

/**
 * First runs on the machines of ./machines.ts (old NVIDIA driver, Turing, Volta, AMD with/without ROCm, Intel, several GPUs, macOS,
 * a GPU the engine cannot use, a 2 GB card, a 6 GB card, a laptop with a 2 GB card and a usable integrated GPU).
 */
export type MachineScenario =
  | 'machineOldDriver'
  | 'machineTuring'
  | 'machineVolta'
  | 'machineAmdRocm'
  | 'machineAmd'
  | 'machineIntel'
  | 'machineMultiGpu'
  | 'machineMac'
  | 'machineUnusableGpu'
  | 'machineTinyGpu'
  | 'machineSmallGpu'
  | 'machineLaptopSmallGpu'

/** Fresh state for a scenario; `patch` replaces top-level keys. */
export function scenario(name: ScenarioName = 'ready', patch: Partial<MockBackendState> = {}): MockBackendState {
  const base: MockBackendState = {
    settings: settingsFixture({ onboardingState: 'completed' }),
    env: envReportFixture(),
    update: updaterStateFixture(),
    catalog: catalogFixture({ installed: SFT_BUNDLE_IDS }),
    downloads: [],
    jobs: [],
    jobLogs: {},
    diagnostics: [],
    devices: [launchDeviceFixture()],
    launchRows: [],
    gpuInventory: gpuInventoryFixture(),
    engineReadiness: engineReadyFixture(),
    engineVersions: [engineVersionFixture()],
    engineDownload: null,
    engineReleases: [engineReleaseFixture()],
    trainerVersions: [trainerVersionFixture()],
    hosts: [],
    // The newest one carries a negative prompt, as images made in 创作 do (the detail panel reads it).
    gallery: [
      galleryItemFixture(0, { negativePrompt: 'blurry, watermark' } as Partial<GalleryDetail>),
      galleryItemFixture(1),
      galleryItemFixture(2),
    ],
    projects: [],
    manga: [],
    aiCompletions: [],
    pickedImages: [],
    aiProviders: [],
    conversations: [],
    aiTurn: [],
    gbc: { status: gbcStatusFixture(false), versions: [], parse: gbcParseFixture(), job: null },
    engineFeatures: engineFeaturesFixture(),
    controlAdapters: [],
    install: installStateFixture(),
    engineMachine: machineFixture('nvidia'),
    engineAssets: RELEASE_220,
    importFiles: {},
    importPick: null,
    importHold: false,
    modelImport: null,
    systemMemoryBytes: 32 * GiB,
    diskFree: {},
    // Ready to train on 本机 (RTX 4070, 12 GB), no trainings yet.
    training: trainingStateFixture(),
  }

  const firstRun = (): Partial<MockBackendState> => ({
    settings: settingsFixture({ onboardingState: 'pending' }),
    catalog: catalogFixture(),
    engineReadiness: engineMissingFixture(),
    engineVersions: [],
    engineFeatures: null,
    gallery: [],
  })

  const variants: Record<Exclude<ScenarioName, MachineScenario>, () => Partial<MockBackendState>> = {
    /** Nothing installed: onboarding pending, no engine, no model, a usable GPU. */
    firstRun,
    sharedModelDirectory: () => ({
      ...firstRun(),
      engineReadiness: engineReadyFixture(),
      sharedModelDirectory: { available: true },
    }),
    /** First run on a machine without an NVIDIA GPU. */
    noGpu: () => ({
      ...firstRun(),
      devices: [launchDeviceFixture({ id: 'cpu', name: 'CPU', kind: 'cpu', detail: 'Fixture CPU', memoryBytes: undefined })],
      gpuInventory: gpuInventoryFixture([]),
      engineMachine: { ...machineFixture('nvidia'), gpus: [] },
    }),
    /** First run with the engine download in flight. */
    engineInstalling: () => ({
      ...firstRun(),
      engineDownload: engineDownloadFixture({ phase: 'downloading', bytes: 450_000_000, percent: 50, speedBps: 20_000_000 }),
    }),
    /** Engine ready but none of the bundle's weights are present. */
    engineInstalledModelMissing: () => ({
      settings: settingsFixture({ onboardingState: 'active' }),
      catalog: catalogFixture(),
    }),
    /** Engine ready on an RTX 5090 (the only kind that runs NVFP4), no model downloaded yet. */
    modelMissingRtx50: () => ({
      settings: settingsFixture({ onboardingState: 'completed' }),
      catalog: catalogFixture(),
      gpuInventory: gpuInventoryFixture([GPU_RTX_5090()]),
    }),
    /** Two components installed, the DiT interrupted mid-download. */
    modelPartiallyDownloaded: () => ({
      settings: settingsFixture({ onboardingState: 'active' }),
      catalog: catalogFixture({ installed: ['qwen35-encoder', 'flux2-vae-small'], partial: ['moss-sft-dit'] }),
    }),
    /** Engine and the recommended bundle installed. */
    ready: () => ({}),
    /** 导入模型: what the engine says about the files a spec drops or picks (importFixtures), the runtime config already here. */
    modelImport: () => ({
      catalog: catalogFixture({ installed: [...SFT_BUNDLE_IDS, 'moss-runtime-config'] }),
      importFiles: importFixtures(),
    }),
    /** 我的模型 has a combination whose own main model was on a disk that is not plugged in. */
    modelFileMoved: () => {
      const catalog = catalogFixture({
        installed: [...SFT_BUNDLE_IDS, 'qwen35-comfy-int8_convrot', 'flux2-vae-comfy-small', 'moss-runtime-config'],
      })
      const moved = movedOwnFileFixture()
      const combination = combinationBundle(
        {
          id: 'combo-moved',
          name: '我的 INT8',
          components: { dit: moved.id, textEncoder: 'qwen35-comfy-int8_convrot', vae: 'flux2-vae-comfy-small' },
          createdAt: FIXTURE_NOW,
        },
        [...catalog.models, moved],
      )
      return {
        catalog: { ...catalog, models: [...catalog.models, moved], bundles: [...catalog.bundles, combination] },
        importPick: ['F:\\Models\\moss_image_sft_int8.safetensors'],
      }
    },
    /** Ready, with one failed job in history and its diagnostic. */
    jobFailure: () => ({
      jobs: [
        jobFixture({
          id: 'job-failed',
          state: 'failed',
          stage: 'denoise',
          // As main records it: the engine's code, and its own words (also in the job log).
          error: { code: 'E_OOM', message: 'CUDA out of memory. Tried to allocate 2.00 GiB' },
          endedAt: FIXTURE_NOW,
        }),
      ],
      jobLogs: {
        'job-failed': [
          { jobId: 'job-failed', seq: 1, at: FIXTURE_NOW, stream: 'stderr', text: 'CUDA out of memory. Tried to allocate 2.00 GiB' },
        ],
      },
      diagnostics: [diagnosticFixture({ jobId: 'job-failed' })],
    }),
    /** Ready, and a newer release is published. */
    updateAvailable: () => ({ update: updateAvailableFixture('1.1.0') }),
    /** Ready locally plus one SSH host with a GPU. */
    remoteHost: () => ({ hosts: [sshHostFixture()] }),
    /** Ready on an Intel Arc that only moss-infer-vulkan runs (兼容模式): text to image only, no LoRA. */
    vulkanOnly: () => ({
      gpuInventory: gpuInventoryFixture([
        gpuDeviceFixture({
          uuid: 'vk-8086-56a0-0',
          name: 'Intel(R) Arc(TM) A770 Graphics',
          vendor: 'intel',
          pciId: '8086:56a0',
          vulkanIndex: 0,
          computeCapability: undefined,
          driverVersion: undefined,
          utilizationPercent: undefined,
          memoryFreeBytes: undefined,
          memoryTotalBytes: 16 * 1024 ** 3,
        }),
      ]),
      engineFeatures: cliEngineFeatures('vulkan'),
    }),
    /** First run on a computer with 8 GB of memory: it runs, slowly. */
    lowMemory: () => ({ ...firstRun(), systemMemoryBytes: 8 * GiB }),
    /** First run where the models folder has 12 GB free, less than the download needs. */
    lowDisk: () => ({ ...firstRun(), diskFree: { [FIXTURE_MODELS_PATH]: 12 * GiB } }),
    /** 训练 on, nothing for it here yet: the base model and the trainer still to get. */
    trainingNotPrepared: () => ({
      settings: settingsFixture({ onboardingState: 'completed', trainingEnabled: true }),
      training: trainingStateFixture({ readiness: trainingNotPreparedFixture() }),
    }),
    /** 训练 on, on a computer without an NVIDIA card. */
    trainingBlocked: () => ({
      settings: settingsFixture({ onboardingState: 'completed', trainingEnabled: true }),
      training: trainingStateFixture({ readiness: trainingBlockedFixture() }),
    }),
    /** 训练 on and ready, with trainings in every state (one running). */
    trainings: () => {
      const { jobs, ...rest } = trainingsFixture()
      const catalog = catalogFixture({ installed: SFT_BUNDLE_IDS })
      // The LoRA the finished trainings saved are in 模型, as main registers them.
      const trained = rest.projects.flatMap((project) => (project.adapterId ? [trainedAdapterFixture(project.id, project.name)] : []))
      return {
        settings: settingsFixture({ onboardingState: 'completed', trainingEnabled: true }),
        catalog: { ...catalog, adapters: [...catalog.adapters, ...trained] },
        jobs,
        training: trainingStateFixture(rest),
      }
    },
  }

  /** First run on each kind of machine the engine chooser knows. */
  const onMachine = (machine: MachineName) => (): Partial<MockBackendState> => {
    const engineMachine = machineFixture(machine)
    return { ...firstRun(), engineMachine, gpuInventory: gpuInventoryFixture(inventoryDevicesFor(engineMachine)) }
  }
  const machines: Record<MachineScenario, () => Partial<MockBackendState>> = {
    machineOldDriver: onMachine('nvidiaOldDriver'),
    machineTuring: onMachine('turing'),
    machineVolta: onMachine('volta'),
    machineAmdRocm: onMachine('amdRocm'),
    machineAmd: onMachine('amd'),
    machineIntel: onMachine('intel'),
    machineMultiGpu: onMachine('multiGpu'),
    machineMac: onMachine('macos'),
    machineUnusableGpu: onMachine('unusableGpu'),
    machineTinyGpu: onMachine('tinyGpu'),
    machineSmallGpu: onMachine('smallGpu'),
    // Main recommends the GPU that can run the model, not the 2 GB card (recommendedGpu).
    machineLaptopSmallGpu: () => {
      const machine = onMachine('laptopSmallGpu')()
      return { ...machine, gpuInventory: { ...machine.gpuInventory!, recommendedGpuUuid: machineFixture('laptopSmallGpu').gpus[1]!.id } }
    },
  }

  const variant = name in machines ? machines[name as MachineScenario] : variants[name as Exclude<ScenarioName, MachineScenario>]
  return { ...base, ...variant(), ...patch }
}
