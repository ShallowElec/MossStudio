import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUILTIN_CAPABILITY_REGISTRY,
  composeOfficialGuide,
  sha256Text,
  projectCapabilities,
  type AppActionArgs,
  type CapabilityId,
} from '@shared/capabilities'
import { writeFileAtomic } from '../lib/atomicWrite'
import { paths } from '../lib/paths'
import type { ManagedHost, Settings } from '@shared/types'
import { remoteEngineInfo } from '../services/engines'
import { mergeLoraMeta } from '../services/loraProfiles'
import { changeRemoteWorkerLora, listRemoteWorkerLoras } from '../services/remoteWorker'
import { getTrainingHost, listManagedHosts, testTrainingHost } from '../services/trainingHosts'
import { connectWorkerHost, isWorkerDaemonHost, workerHostsOn } from '../services/workerHostManager'
import { listControlAdapters } from '../services/controlAdapters'
import { getGpuInventory } from '../services/devices'
import { listDiagnostics } from '../services/diagnostics'
import { getEngineFeatures } from '../services/engineFeatures'
import { engineReadiness } from '../services/engineReadiness'
import { galleryDetail, listGallery, readGalleryFile, trashGalleryItem } from '../services/gallery'
import { openWindow } from '../windows'
import { cancelGbcJob, gbcJobSnapshot, gbcStatus, parseRegions, startGbcJob } from '../services/gbc'
import { deleteSeries, getSeries, listSeries, saveSeries } from '../services/manga'
import {
  cancelDownload,
  deleteModel,
  getCatalog,
  installBundle,
  invalidateCatalog,
  listDownloads,
  modelSpace,
  pauseDownload,
  startDownload,
} from '../services/models'
import { deleteProject, getProject, listProjects } from '../services/projects'
import { listRemoteDownloads } from '../services/remoteDownloads'
import { getSettings } from '../services/settings'
import { cancelJob, getJob, getJobLogs, listJobs } from '../services/supervisor'
import { autoCaption } from '../services/training/captions'
import { scanDataset, setCaption } from '../services/training/dataset'
import { trainingReadiness } from '../services/training/readiness'
import {
  trainingChooseStep,
  trainingCommand,
  trainingCreate,
  trainingDuplicate,
  trainingGet,
  trainingList,
  trainingRemove,
  trainingSamples,
  trainingStart,
  trainingStop,
  trainingUpdate,
} from '../services/training/run'
import { assertDatasetEditable, getTrainingProject } from '../services/training/store'
import { prepareAgentPaths } from './agentPaths'
import { listCapabilityAudit } from './audit'
import { createMainCapabilityDispatcher, type MainCapabilityDispatcher, type MainCapabilityHandler } from './dispatcher'

/**
 * Built-in main-process capability handlers covering projects, GBC, Library,
 * Models, Manga, Training and System diagnostics/audit.
 */

type AppArgsMap = {
  [K in import('@shared/capabilities').AppActionId]: AppActionArgs<K>
}

function typed<Id extends keyof AppArgsMap>(fn: (args: AppArgsMap[Id]) => unknown | Promise<unknown>): MainCapabilityHandler {
  return (args) => fn(args as AppArgsMap[Id])
}

/** The 设置 › 功能 switches capability packs are gated by. */
export function capabilityFlags(settings: Settings): Record<string, boolean> {
  return {
    gbcEnabled: settings.gbcEnabled === true,
    trainingEnabled: settings.trainingEnabled === true,
    remoteHostsEnabled: settings.remoteHostsEnabled === true,
    workerHostsEnabled: workerHostsOn(settings),
  }
}

function publicRemoteHost(host: ManagedHost) {
  // Allowlist both host and device fields so future credential fields cannot leak to agents.
  return {
    id: host.id,
    name: host.name,
    kind: host.kind,
    remoteBackend: host.remoteBackend ?? 'moss-ssh',
    status: host.status,
    devices: host.devices.map(({ id, name, kind, memoryBytes, available, source }) => ({
      id,
      name,
      kind,
      memoryBytes,
      available,
      source,
    })),
  }
}

async function remoteWorkerProfile(hostId: string) {
  const host = getTrainingHost(getSettings(), hostId)
  if (!isWorkerDaemonHost(host)) throw new Error('请选择远端工作节点')
  return connectWorkerHost(host)
}

export function createBuiltinMainHandlers(): Record<string, MainCapabilityHandler> {
  return {
    // ---- remote.hosts ----
    'remote.hosts.list': () => ({
      hosts: listManagedHosts(getSettings())
        .filter((host) => host.kind === 'ssh')
        .map(publicRemoteHost),
    }),
    'remote.hosts.test': typed<'remote.hosts.test'>(async ({ hostId }) => {
      const settings = getSettings()
      const host = getTrainingHost(settings, hostId)
      if (!host || host.kind !== 'ssh') throw new Error('请选择远程主机')
      const checked = await testTrainingHost(settings, hostId)
      invalidateCatalog()
      const managed = listManagedHosts(settings).find((item) => item.id === hostId)
      if (!managed) throw new Error('远程主机不存在')
      return publicRemoteHost({ ...managed, status: checked.status })
    }),
    'remote.hosts.status': typed<'remote.hosts.status'>(({ hostId, refresh }) => remoteEngineInfo(hostId, refresh)),
    'remote.hosts.loras_list': typed<'remote.hosts.loras_list'>(async ({ hostId, candidates }) => {
      const profile = await remoteWorkerProfile(hostId)
      return Promise.all((await listRemoteWorkerLoras(profile, candidates)).items.map((item) => mergeLoraMeta(item)))
    }),
    'remote.hosts.lora_register': typed<'remote.hosts.lora_register'>(async ({ hostId, id, action }) => {
      const result = await changeRemoteWorkerLora(await remoteWorkerProfile(hostId), id, action)
      invalidateCatalog()
      return result
    }),

    // ---- studio.projects (headless main operations) ----
    'studio.projects.list': () => ({ projects: listProjects() }),
    'studio.projects.get': typed<'studio.projects.get'>(({ id }) => {
      const project = getProject(id)
      if (!project) throw new Error(`没有这个项目：${id}`)
      return project
    }),
    'studio.projects.delete': typed<'studio.projects.delete'>(({ id }) => {
      deleteProject(id)
      return { deleted: id }
    }),

    // ---- studio.gbc.parse ----
    'studio.gbc.status': typed<'studio.gbc.status'>(({ versionId, fresh }) => gbcStatus(versionId, fresh)),
    'studio.gbc.parse_image': typed<'studio.gbc.parse_image'>(({ runId, path }) => parseRegions(runId, path)),
    'studio.gbc.start_job': typed<'studio.gbc.start_job'>((input) =>
      startGbcJob({
        ...input,
        detector: input.detector ?? 'owlv2',
        versionId: input.versionId ?? undefined,
      }),
    ),
    'studio.gbc.job_snapshot': typed<'studio.gbc.job_snapshot'>(({ jobId }) => gbcJobSnapshot(jobId)),
    'studio.gbc.job_cancel': typed<'studio.gbc.job_cancel'>(({ jobId }) => {
      cancelGbcJob(jobId)
      return { canceled: true, jobId }
    }),

    // ---- library.assets ----
    'library.assets.list': typed<'library.assets.list'>((input) =>
      listGallery(getSettings(), {
        ...input,
        limit: input.limit ?? 48,
      }),
    ),
    'library.assets.get': typed<'library.assets.get'>(({ path }) => galleryDetail(path)),
    'library.assets.read_image': typed<'library.assets.read_image'>(({ path }) => readGalleryFile(path)),
    'library.assets.trash': typed<'library.assets.trash'>(({ path }) => trashGalleryItem(path)),

    // ---- models.catalog ----
    'models.catalog.get': typed<'models.catalog.get'>(({ refresh }) => getCatalog(getSettings(), refresh === true)),
    'models.catalog.installed': async () => {
      const catalog = await getCatalog(getSettings())
      const installedModels = catalog.models.filter((model) => model.installed)
      const installedIds = new Set(installedModels.map((model) => model.id))
      const installedBundles = catalog.bundles.filter((bundle) => {
        const needed = [bundle.components.dit, bundle.components.textEncoder, bundle.components.vae, bundle.support].filter(Boolean)
        return needed.every((id) => installedIds.has(id!))
      })
      const installedAdapters = catalog.adapters.filter((adapter) => adapter.installed)
      return { models: installedModels, bundles: installedBundles, adapters: installedAdapters }
    },
    'models.control_adapters.list': () => ({ adapters: listControlAdapters() }),
    'models.downloads.list': () => ({ downloads: [...listDownloads(), ...listRemoteDownloads()] }),
    'models.space.check': typed<'models.space.check'>(({ modelIds }) => ({ disks: modelSpace(getSettings(), modelIds) })),
    'models.bundles.install': typed<'models.bundles.install'>(({ id }) => installBundle(id, getSettings())),
    'models.downloads.start': typed<'models.downloads.start'>(({ kind, id }) => startDownload(kind, id, getSettings())),
    'models.downloads.pause': typed<'models.downloads.pause'>(({ taskId }) => {
      pauseDownload(taskId)
      return { paused: true, taskId }
    }),
    'models.downloads.cancel': typed<'models.downloads.cancel'>(async ({ taskId }) => {
      await cancelDownload(taskId)
      return { canceled: true, taskId }
    }),
    'models.catalog.delete': typed<'models.catalog.delete'>(async ({ kind, id }) => {
      await deleteModel(kind, id, getSettings())
      return { deleted: true, kind, id }
    }),

    // ---- manga.series ----
    'manga.series.list': () => ({ series: listSeries() }),
    'manga.series.get': typed<'manga.series.get'>(({ id }) => {
      const series = getSeries(id)
      if (!series) throw new Error(`没有这部漫画：${id}`)
      return series
    }),
    'manga.series.save': typed<'manga.series.save'>(({ series }) => saveSeries(series)),
    'manga.series.delete': typed<'manga.series.delete'>(({ id }) => {
      deleteSeries(id)
      return { deleted: id }
    }),

    // ---- training.jobs ----
    'training.readiness.get': typed<'training.readiness.get'>(({ hostId }) => trainingReadiness(hostId)),
    'training.projects.list': async () => ({ trainings: await trainingList() }),
    'training.projects.get': typed<'training.projects.get'>(({ id }) => trainingGet(id)),
    'training.projects.create': typed<'training.projects.create'>(({ kind, hostId }) => trainingCreate(kind, hostId)),
    'training.projects.update': typed<'training.projects.update'>(({ id, patch }) => trainingUpdate(id, patch)),
    'training.projects.duplicate': typed<'training.projects.duplicate'>(({ id }) => trainingDuplicate(id)),
    'training.projects.delete': typed<'training.projects.delete'>(async ({ id }) => {
      await trainingRemove(id)
      return { deleted: id }
    }),
    'training.dataset.list': typed<'training.dataset.list'>(async ({ id }) => {
      await getTrainingProject(id)
      return scanDataset(id)
    }),
    'training.dataset.set_caption': typed<'training.dataset.set_caption'>(async ({ id, name, caption }) => {
      await assertDatasetEditable(id)
      return setCaption(id, name, caption)
    }),
    'training.dataset.auto_caption': typed<'training.dataset.auto_caption'>(async ({ id, names }) => {
      await assertDatasetEditable(id)
      return autoCaption(id, names)
    }),
    'training.runs.samples': typed<'training.runs.samples'>(({ id }) => trainingSamples(id)),
    'training.runs.command': typed<'training.runs.command'>(({ id }) => ({ command: trainingCommand(id) })),
    'training.runs.start': typed<'training.runs.start'>(({ id }) => trainingStart(id)),
    'training.runs.stop': typed<'training.runs.stop'>(({ id }) => trainingStop(id)),
    'training.runs.choose_step': typed<'training.runs.choose_step'>(({ id, step }) => trainingChooseStep(id, step)),

    // ---- system.runtime ----
    'system.engine.status': () => engineReadiness(),
    'system.engine.features': typed<'system.engine.features'>((target) => getEngineFeatures(target)),
    'system.gpu.inventory': () => getGpuInventory(),
    'system.jobs.list': async () => ({ jobs: await listJobs() }),
    'system.jobs.get': typed<'system.jobs.get'>(({ id }) => knownJob(id)),
    'system.jobs.logs': typed<'system.jobs.logs'>(async ({ id }) => getJobLogs((await knownJob(id)).id)),
    'system.jobs.cancel': typed<'system.jobs.cancel'>(async ({ id }) => cancelJob((await knownJob(id)).id)),
    'system.diagnostics.list': () => ({ diagnostics: listDiagnostics() }),
    'system.context.get': async () => {
      const settings = getSettings()
      const [catalog, jobs, engine] = await Promise.all([getCatalog(settings), listJobs(), engineReadiness()])
      const installedModels = catalog.models.filter((model) => model.installed)
      const installedIds = new Set(installedModels.map((model) => model.id))
      const installedBundles = catalog.bundles.filter((bundle) => {
        const needed = [bundle.components.dit, bundle.components.textEncoder, bundle.components.vae, bundle.support].filter(Boolean)
        return needed.every((id) => installedIds.has(id!))
      })
      return {
        projects: listProjects(),
        jobs: jobs.slice(0, 30),
        engine,
        installedBundles: installedBundles.map((bundle) => ({ id: bundle.id, name: bundle.name, recommended: bundle.recommended })),
        installedAdapters: catalog.adapters
          .filter((adapter) => adapter.installed)
          .map((adapter) => ({ id: adapter.id, name: adapter.name })),
        controlAdapters: listControlAdapters().map((adapter) => ({
          id: adapter.id,
          name: adapter.name,
          controlKinds: adapter.controlKinds,
        })),
        enabledFlags: capabilityFlags(settings),
      }
    },
    'system.window.focus': typed<'system.window.focus'>(({ route }) => {
      openWindow('studio', route)
      return { focused: true, ...(route ? { route } : {}) }
    }),
    'system.reviews.record': typed<'system.reviews.record'>(async ({ jobId, observations, issues, nextChange }) => {
      await knownJob(jobId)
      const review = {
        jobId,
        observations,
        issues,
        nextChange: nextChange ?? '',
        status: 'recorded' as const,
        at: new Date().toISOString(),
      }
      mkdirSync(paths.capabilityReviews(), { recursive: true })
      await writeFileAtomic(join(paths.capabilityReviews(), `${jobId}.json`), JSON.stringify(review, null, 2))
      return review
    }),
    'system.reviews.get': typed<'system.reviews.get'>(({ jobId }) => {
      const file = join(paths.capabilityReviews(), `${jobId}.json`)
      if (!existsSync(file)) return null
      return JSON.parse(readFileSync(file, 'utf8')) as unknown
    }),
    'system.audit.recent': typed<'system.audit.recent'>(async (query) => ({
      entries: await listCapabilityAudit({ ...query, source: 'external-agent' }),
    })),
    'system.guide.read': typed<'system.guide.read'>(({ topic, profile, enabledPacks }) => {
      const settings = getSettings()
      const projected = projectCapabilities(BUILTIN_CAPABILITY_REGISTRY, {
        profile: profile ?? 'atomic',
        enabledFlags: capabilityFlags(settings),
        enabledPacks: enabledPacks as CapabilityId[] | undefined,
      })
      const activeTopic = topic ?? 'all'
      const markdown = composeOfficialGuide(projected.skill.markdown, activeTopic)
      return {
        topic: activeTopic,
        profile: projected.profile,
        actionCount: projected.actions.length,
        ...projected.skill,
        markdown,
        digest: sha256Text(markdown),
      }
    }),
  }
}

/** Job ids as the supervisor makes them; anything else never reaches a file name. */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/

/** A job the supervisor knows, by an id that is safe in a file name. */
async function knownJob(id: string) {
  const job = JOB_ID.test(id) ? await getJob(id) : null
  if (!job) throw new Error(`任务不存在：${id}`)
  return job
}

/** The recipe and computer a training run would use, shown in its approval. */
async function trainingRunDetail(id: string): Promise<string> {
  const project = await trainingGet(id)
  const { recipe } = project
  const host = project.hostId === 'local' ? '本机' : (getTrainingHost(getSettings(), project.hostId)?.name ?? project.hostId)
  const shape = [
    recipe.algo,
    recipe.dim !== null ? `dim ${recipe.dim}` : '',
    `${recipe.steps} 步`,
    `batch ${recipe.batch}`,
    `${recipe.resolution}px`,
  ]
  return `「${project.name}」在${host}上训练：${shape.filter(Boolean).join(' · ')}${recipe.overrides.trim() ? ' · 含自定义参数' : ''}`
}

export function createBuiltinMainDispatcher(): MainCapabilityDispatcher {
  return createMainCapabilityDispatcher({
    mainHandlers: createBuiltinMainHandlers(),
    readFlags: () => capabilityFlags(getSettings()),
    prepareArgs: (action, args) => prepareAgentPaths(action, args),
    approvalDetail: async (action, args) =>
      action.id === 'training.runs.start' && typeof args.id === 'string' ? trainingRunDetail(args.id) : undefined,
  })
}
