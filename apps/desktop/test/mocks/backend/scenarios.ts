/**
 * The mutable state behind the mock backend, plus named starting scenarios.
 *
 * A scenario is plain data: handlers in ./index.ts read and write this state, so
 * a test changes what the "main process" knows by editing `backend.state`.
 */
import type { McpClientStatus } from '@shared/mcpClients'
import type { MangaSeries } from '@shared/manga/model'
import type { AiConversationInfo, AiProviderInfo, AiToolCall } from '@shared/ai'
import type { PendingCapabilityApproval } from '@shared/agentHub'
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
  LoraProfile,
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

/** What main's agent hub, MCP client installer and Worker daemon answer. */
export interface MockAgentsState {
  backends: import('@shared/agentHub').AgentBackendInfo[]
  projects?: import('@shared/agentHub').AgentProject[]
  sessions: Array<{ id: string; title: string; cwd?: string; projectId?: string; updatedAt?: number; running?: boolean }>
  messages: Record<string, import('@shared/agentHub').AgentMessagePage>
  approvals: PendingCapabilityApproval[]
  clients: McpClientStatus[]
  workerLoras: Array<{ id: string; name: string; sizeBytes: number; registered: boolean; triggers?: string[] }>
  /** While set, every agent-hub:send fails with this message, the way the ACP driver reports a dropped Agent. */
  sendError?: string
  workerModels: Array<{
    id: string
    name: string
    variant?: string[]
    tier?: 'reference' | 'high' | 'turbo'
    profile?: string
    catalogBundleId?: string
    sizeBytes?: number
    defaults?: { steps?: number; cfg?: number }
  }>
  /** What the Agent answers its model list with (agent-hub:models). */
  models: Array<{ id: string; label: string; provider?: string }>
}

export function agentsStateFixture(patch: Partial<MockAgentsState> = {}): MockAgentsState {
  return { backends: [], sessions: [], messages: {}, approvals: [], clients: [], workerLoras: [], workerModels: [], models: [], ...patch }
}

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
  /** 外部 Agent (协同 panel, MCP clients, approvals) and the LoRA of a Worker host. */
  agents: MockAgentsState
  /** Remembered LoRA trigger words (lora-profiles.json). */
  loraProfiles: LoraProfile[]
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
  | 'externalAgents'
  | 'workerHost'

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
    agents: agentsStateFixture(),
    loraProfiles: [],
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
    /** 外部 Agent on: Codex connected with one conversation, Codex registered, Claude Code without its CLI, one request waiting. */
    externalAgents: () => ({
      settings: settingsFixture({ onboardingState: 'completed', externalAgentsEnabled: true }),
      agents: agentsStateFixture({
        backends: [
          { id: 'dsh-desktop', label: 'DSH Desktop', kind: 'dsh-desktop', available: false, connected: false },
          { id: 'codex-acp', label: 'Codex ACP', kind: 'acp', available: true, preferred: true, connected: true, resumable: true },
          { id: 'custom-acp', label: '自定义 ACP', kind: 'acp', available: true, connected: false },
        ],
        sessions: [{ id: 'session-1', title: '海报', cwd: 'F:\\work\\poster', updatedAt: Date.parse(FIXTURE_NOW) }],
        messages: {
          'session-1': {
            messages: [
              { seq: 1, role: 'user', text: '画一张海边的海报' },
              { seq: 2, role: 'assistant', text: '好的，已经新建画面并开始生成。' },
            ],
            hasMore: false,
            asOfSeq: 2,
          },
        },
        approvals: [
          {
            id: 'approval-1',
            actionId: 'studio.projects.delete',
            packId: 'studio.projects',
            title: '删除项目',
            summary: '删除项目 旧海报',
            argsPreview: '{"id":"p-old"}',
            source: 'external-agent',
            createdAt: FIXTURE_NOW,
          },
        ],
        clients: [
          {
            id: 'codex',
            label: 'Codex',
            configPath: '/home/moss/.codex/config.toml',
            state: 'configured',
            installMode: 'auto',
            detail: '',
          },
          {
            id: 'claude-code',
            label: 'Claude Code',
            configPath: '/home/moss/.claude.json',
            state: 'not_found',
            installMode: 'copy-only',
            detail: '没有找到 claude 命令，可以复制 MCP 配置手动添加',
          },
          {
            id: 'dsh',
            label: 'DeepSeek Harness 桌面版',
            state: 'detected',
            configPath: '/fixture/.dsh',
            installMode: 'copy-only',
            detail: '复制后，在 DSH 中手动填写并保存 MCP 客户端配置。',
          },
        ],
      }),
    }),
    /** 远程主机 and Worker 远程主机 on, with one Worker host that has two LoRA (one registered, with a trigger word). */
    workerHost: () => ({
      settings: settingsFixture({ onboardingState: 'completed', remoteHostsEnabled: true, workerHostsEnabled: true }),
      hosts: [
        sshHostFixture({
          id: 'worker-1',
          name: 'GPU Worker',
          host: 'worker.example.test',
          remoteBackend: 'worker-daemon',
          workerDiscoveryPath: '/srv/worker/discovery.json',
          workerWorkflow: 'explicit-wf',
        }),
      ],
      agents: agentsStateFixture({
        workerLoras: [
          { id: 'styles/ink.safetensors', name: 'ink.safetensors', sizeBytes: 151_000_000, registered: true, triggers: ['ink style'] },
          { id: 'styles/wash.safetensors', name: 'wash.safetensors', sizeBytes: 98_000_000, registered: false },
        ],
        workerModels: [
          {
            id: 'moss-sft',
            name: 'MOSS-Image SFT',
            variant: ['BF16'],
            tier: 'reference',
            profile: 'standard',
            catalogBundleId: 'moss-sft',
            sizeBytes: 27_200_000_000,
          },
          // A Worker names its models its own way; catalogBundleId ties one to the library.
          {
            id: 'sft-int8',
            name: 'MOSS-Image SFT INT8',
            variant: ['INT8'],
            tier: 'high',
            profile: 'standard',
            catalogBundleId: 'moss-sft-int8',
            sizeBytes: 9_600_000_000,
          },
        ],
      }),
    }),
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
