import type { AdapterEntry, CanvasAdapter, Catalog, LoraMetadata, ManagedHost, ModelBundle, RemoteHostBackend } from '@shared/types'
import type { RemoteWorkerLoraItem, RemoteWorkerModelInventory, RemoteWorkerModelItem } from '@shared/remoteWorker'
import { isWorkerLoraId, workerCanvasAdapter } from '@shared/remoteWorker'
import { bundleInstalled, type BundleChoice } from './readiness'

/**
 * A Worker daemon picked as 运行位置 is used exactly like an SSH host: the
 * same `hostId`, the same LoRA picker. Only the data behind them differs: the
 * Worker owns its model weights and its LoRA inventory, so nothing on this
 * computer has to be downloaded first.
 */

export type WorkerLoraItem = RemoteWorkerLoraItem & LoraMetadata

/** A LoRA of a Worker, shaped as a library entry so the picker and the 画面 rows read it unchanged. */
export type WorkerAdapterEntry = AdapterEntry & LoraMetadata & { workerId: string; registered: boolean }

export function isWorkerDaemonHost(
  host: { remoteBackend?: RemoteHostBackend } | null | undefined,
): host is { remoteBackend: 'worker-daemon' } {
  return host?.remoteBackend === 'worker-daemon'
}

/** Same rule as main's `workerHostProviderId`: the id its connected profile (and model) carries. */
export function workerProviderId(host: Pick<ManagedHost, 'id' | 'workerProviderId'>): string {
  const custom = host.workerProviderId?.trim()
  if (custom && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(custom)) return custom
  return `worker-${host.id}`
}

/**
 * The model a run on a Worker host uses: the one main lists for its connected
 * profile, or the same id when the catalog has not caught up yet. Main routes
 * a `remote-worker:` binding to the Worker and checks the profile again there.
 */
export function workerBundleChoice(
  host: Pick<ManagedHost, 'id' | 'name' | 'workerProviderId'>,
  catalog: Pick<Catalog, 'bundles'> | null | undefined,
): BundleChoice {
  const id = `remote-worker:${workerProviderId(host)}`
  const listed = catalog?.bundles.find((bundle) => bundle.id === id)
  const bundle: ModelBundle = listed ?? {
    id,
    name: host.name,
    description: '使用已连接的远端服务',
    components: { dit: id, textEncoder: id, vae: id },
    support: id,
    custom: true,
  }
  return { bundle, installed: true, unavailable: false }
}

/** What `Ipc.remoteWorkerLoras` answers: a list, or `{ items }`; anything malformed is dropped. */
export function parseWorkerLoras(value: unknown): WorkerLoraItem[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items
      : []
  return rows.filter((row): row is WorkerLoraItem => {
    if (!row || typeof row !== 'object') return false
    const item = row as Partial<WorkerLoraItem>
    return isWorkerLoraId(item.id) && typeof item.name === 'string'
  })
}

export function workerAdapterEntries(items: readonly WorkerLoraItem[]): WorkerAdapterEntry[] {
  return items.map((item) => ({
    ...item,
    id: workerCanvasAdapter(item.id, 1).id,
    workerId: item.id,
    name: item.name || item.id,
    provider: 'local',
    repo: '',
    revision: '',
    kind: 'lora',
    license: '',
    files: [item.id],
    sizeBytes: Number.isFinite(item.sizeBytes) ? item.sizeBytes : 0,
    installedBytes: 0,
    tags: ['remote-worker'],
    // Only a registered LoRA can be sent to the Worker.
    installed: item.registered !== false,
    registered: item.registered !== false,
  }))
}

/** The 画面's LoRA for a Worker LoRA: a portable id, plus its Worker path when the id had to be hashed. */
export function workerAdapterFor(entry: Pick<WorkerAdapterEntry, 'workerId'>, strength: number): CanvasAdapter {
  return workerCanvasAdapter(entry.workerId, strength)
}

/** Convert real models detected on a Worker daemon into ModelBundle objects for ModelPicker & Studio. */
export function workerModelBundles(items: readonly RemoteWorkerModelItem[]): ModelBundle[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    variant: item.variant,
    description: item.description ?? '',
    tier: item.tier === 'high' || item.tier === 'turbo' ? item.tier : undefined,
    defaults:
      item.defaults?.steps !== undefined && item.defaults?.cfg !== undefined
        ? { steps: item.defaults.steps, cfg: item.defaults.cfg }
        : undefined,
    certified: Boolean(item.catalogBundleId),
    components: { dit: item.id, textEncoder: item.id, vae: item.id },
    support: item.id,
  }))
}

/**
 * Resolve which model to run on a Worker daemon host.
 * Uses the real models detected on the Worker (`/v1/models`) when available,
 * falling back to the legacy `remote-worker:` placeholder while offline or
 * talking to an older daemon that does not list its models. `ids` are tried in
 * order, each as a Worker model id or as the catalog bundle a Worker model is.
 */
export function resolveWorkerBundle(
  host: Pick<ManagedHost, 'id' | 'name' | 'workerProviderId'>,
  inventory: RemoteWorkerModelInventory | null | undefined,
  ids: ReadonlyArray<string | null | undefined>,
  catalog: Pick<Catalog, 'bundles'> | null | undefined,
): BundleChoice {
  const models = inventory?.models ?? []
  if (!models.length) return workerBundleChoice(host, catalog)
  const bundles = workerModelBundles(models)
  const byId = (id: string | null | undefined): ModelBundle | undefined => {
    const item = id ? (models.find((model) => model.id === id) ?? models.find((model) => model.catalogBundleId === id)) : undefined
    return item && bundles.find((bundle) => bundle.id === item.id)
  }
  const picked = [...ids, inventory?.defaultModelId].map(byId).find(Boolean) ?? bundles[0]!
  return { bundle: picked, installed: true, unavailable: false }
}

/** A model picked on one Worker host, and the 画面 model it was picked over there. */
export interface WorkerModelPick {
  id: string
  over?: string
}

/**
 * The ids a Worker run tries, in order (see resolveWorkerBundle). A 画面 whose
 * own model the Worker also has runs that one: the host's pick stands in only
 * for the model it was picked over, or when the Worker lacks the 画面's model.
 */
export function workerModelOrder(
  pick: WorkerModelPick | null | undefined,
  canvasModelId: string | undefined,
  preferredId: string | null | undefined,
): Array<string | null | undefined> {
  return pick && pick.over === canvasModelId ? [pick.id, canvasModelId, preferredId] : [canvasModelId, pick?.id, preferredId]
}

/** The Worker picks kept in storage, by host id (a Map, so no host id reaches a prototype). A malformed entry is dropped. */
export function parseWorkerModelPicks(raw: string | null): Map<string, WorkerModelPick> {
  const picks = new Map<string, WorkerModelPick>()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw ?? '{}')
  } catch {
    return picks
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return picks
  for (const [hostId, value] of Object.entries(parsed)) {
    const pick = value as Partial<WorkerModelPick> | null
    if (typeof pick?.id !== 'string' || !pick.id) continue
    picks.set(hostId, typeof pick.over === 'string' ? { id: pick.id, over: pick.over } : { id: pick.id })
  }
  return picks
}

/**
 * The model a 画面 keeps when a Worker model is picked: the catalog model it
 * is, when that is downloaded on this computer, else the one it had. A Worker's
 * own id never goes into the 画面, so it still runs back on this computer.
 */
export function canvasModelForWorkerPick(
  item: Pick<RemoteWorkerModelItem, 'catalogBundleId'> | undefined,
  catalog: Pick<Catalog, 'bundles' | 'models'> | null | undefined,
  current: string | undefined,
): string | undefined {
  const twin = catalog?.bundles.find((bundle) => bundle.id === item?.catalogBundleId)
  return twin && bundleInstalled(twin, catalog!.models) ? twin.id : current
}

/** Why a run waits on a Worker host whose model list has not been read (yet, or at all). */
export function workerModelsUnread(hostName: string): string {
  return `还没有读到「${hostName}」上的模型，请稍后再试`
}

/**
 * The chosen LoRA a Worker does not have registered. Strength 0 disables a
 * LoRA without removing it, so it is never flagged as missing. Unknown (list
 * not read yet, or empty) is never reported: main checks again when the job starts.
 */
export function missingWorkerAdapters(
  adapters: readonly CanvasAdapter[],
  entries: readonly WorkerAdapterEntry[] | null | undefined,
): CanvasAdapter[] {
  if (!entries?.length) return []
  const registered = new Set(entries.filter((entry) => entry.registered).map((entry) => entry.workerId))
  return adapters.filter((adapter) => adapter.strength > 0 && !registered.has(adapter.path ?? adapter.id))
}
