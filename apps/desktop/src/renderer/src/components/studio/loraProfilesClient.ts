import { useEffect, useSyncExternalStore } from 'react'
import { ADAPTER_STRENGTH_DEFAULT, clampAdapterStrength } from '@shared/adapters'
import { Events, Ipc } from '@shared/channels'
import type { CanvasAdapter } from '@shared/types'
import { ApiError, call, onEvent } from '../../lib/api'

/**
 * Trigger words and defaults remembered per LoRA (`lora-profiles:*`). Every
 * read degrades to "no profiles" instead of breaking the LoRA picker or the
 * params panel: profiles are an extra, never a blocker.
 */

export type LoraAutoInsert = 'manual' | 'prefix' | 'suffix'

export interface LoraProfile {
  loraId: string
  triggers: string[]
  suggestedTriggers?: string[]
  negativeTriggers?: string[]
  defaultStrength?: number
  autoInsert?: LoraAutoInsert
  notes?: string
  updatedAt?: string
}

export type LoraProfileMap = Readonly<Record<string, LoraProfile>>

export interface LoraProfileSaveInput {
  loraId: string
  triggers: string[]
  negativeTriggers?: string[]
  defaultStrength?: number
  autoInsert?: LoraAutoInsert
  notes?: string
}

export interface LoraInspectResult {
  loraId: string
  triggers: string[]
  suggestedTriggers: string[]
  source?: string
}

export const AUTO_INSERT_LABELS: Record<LoraAutoInsert, string> = {
  manual: '手动点击',
  prefix: '自动前置',
  suffix: '自动后置',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Trimmed, non-empty, de-duplicated without regard to case; first spelling wins. */
export function cleanTriggers(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const word = item.replace(/\s+/g, ' ').trim()
    const key = word.toLowerCase()
    if (!word || seen.has(key)) continue
    seen.add(key)
    result.push(word)
  }
  return result
}

/** Splits what a person typed into a trigger field: commas (either width), semicolons or new lines. */
export function parseTriggerText(text: string): string[] {
  return cleanTriggers(text.split(/[,，;；\n]/))
}

function strength(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2 ? Math.round(value * 100) / 100 : undefined
}

function autoInsert(value: unknown): LoraAutoInsert | undefined {
  return value === 'manual' || value === 'prefix' || value === 'suffix' ? value : undefined
}

export function normalizeLoraProfile(value: unknown, fallbackId?: string): LoraProfile | null {
  if (!isRecord(value)) return null
  const loraId = typeof value.loraId === 'string' && value.loraId ? value.loraId : fallbackId
  if (!loraId) return null
  const triggers = cleanTriggers(value.triggers)
  const known = new Set(triggers.map((word) => word.toLowerCase()))
  const suggested = cleanTriggers(value.suggestedTriggers).filter((word) => !known.has(word.toLowerCase()))
  const negative = cleanTriggers(value.negativeTriggers)
  const defaultStrength = strength(value.defaultStrength)
  const mode = autoInsert(value.autoInsert)
  const notes = typeof value.notes === 'string' && value.notes.trim() ? value.notes : undefined
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : undefined
  return {
    loraId,
    triggers,
    ...(suggested.length ? { suggestedTriggers: suggested } : {}),
    ...(negative.length ? { negativeTriggers: negative } : {}),
    ...(defaultStrength !== undefined ? { defaultStrength } : {}),
    ...(mode ? { autoInsert: mode } : {}),
    ...(notes ? { notes } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

/** `lora-profiles:list` answers `Record<id, profile>`, `{ profiles: Record }`, or (tolerated) an array. */
export function normalizeLoraProfiles(value: unknown): Record<string, LoraProfile> {
  const source = isRecord(value) && isRecord(value.profiles) ? value.profiles : value
  const result: Record<string, LoraProfile> = {}
  if (Array.isArray(source)) {
    for (const item of source) {
      const profile = normalizeLoraProfile(item)
      if (profile) result[profile.loraId] = profile
    }
    return result
  }
  if (!isRecord(source)) return result
  for (const [key, item] of Object.entries(source)) {
    const profile = normalizeLoraProfile(item, key)
    if (profile) result[profile.loraId] = profile
  }
  return result
}

export function normalizeInspect(value: unknown, loraId: string): LoraInspectResult | null {
  if (!isRecord(value)) return null
  const triggers = cleanTriggers(value.triggers)
  const suggested = cleanTriggers(value.suggestedTriggers)
  return {
    loraId: typeof value.loraId === 'string' && value.loraId ? value.loraId : loraId,
    triggers,
    suggestedTriggers: suggested,
    ...(typeof value.source === 'string' && value.source ? { source: value.source } : {}),
  }
}

/** The key a profile is stored under: a remote LoRA's relative file name, the library id otherwise. */
export function loraProfileKey(adapter: Pick<CanvasAdapter, 'id' | 'path'>): string {
  return adapter.path ?? adapter.id
}

export function findLoraProfile(profiles: LoraProfileMap, adapter: Pick<CanvasAdapter, 'id' | 'path'>): LoraProfile | undefined {
  return profiles[loraProfileKey(adapter)] ?? profiles[adapter.id]
}

/**
 * Merge what a library entry carries from its file header (triggers, notes…)
 * with what the person saved; the saved profile wins field by field.
 */
export function mergeEntryLoraProfile(
  loraId: string,
  source: object | undefined,
  stored: LoraProfile | undefined,
): LoraProfile | undefined {
  const entry = source ? normalizeLoraProfile({ ...source, loraId }) : null
  if (!stored && !entry) return undefined
  const triggers = stored?.triggers.length ? stored.triggers : (entry?.triggers ?? [])
  const triggerSet = new Set(triggers.map((item) => item.toLocaleLowerCase()))
  const suggested = cleanTriggers([...(stored?.suggestedTriggers ?? []), ...(entry?.suggestedTriggers ?? [])]).filter(
    (item) => !triggerSet.has(item.toLocaleLowerCase()),
  )
  const negativeTriggers = stored?.negativeTriggers?.length ? stored.negativeTriggers : (entry?.negativeTriggers ?? [])
  const defaultStrength = stored?.defaultStrength ?? entry?.defaultStrength
  const autoInsert = stored?.autoInsert ?? entry?.autoInsert
  const notes = stored?.notes ?? entry?.notes
  if (!triggers.length && !suggested.length && !negativeTriggers.length && defaultStrength === undefined && !autoInsert && !notes) {
    return stored
  }
  return {
    loraId: stored?.loraId ?? loraId,
    triggers,
    ...(suggested.length ? { suggestedTriggers: suggested } : {}),
    ...(negativeTriggers.length ? { negativeTriggers } : {}),
    ...(defaultStrength !== undefined ? { defaultStrength } : {}),
    ...(autoInsert ? { autoInsert } : {}),
    ...(notes ? { notes } : {}),
    ...(stored?.updatedAt ? { updatedAt: stored.updatedAt } : {}),
  }
}

/** The strength a newly picked LoRA starts at: its remembered recommendation, else the engine default. */
export function recommendedStrength(profiles: LoraProfileMap, loraId: string): number {
  return clampAdapterStrength(profiles[loraId]?.defaultStrength ?? ADAPTER_STRENGTH_DEFAULT)
}

/** A channel the main process has no handler for (older build, or a mock without it). */
function isMissingChannel(error: unknown): boolean {
  if (error instanceof ApiError) return error.code === 'E_MOCK_UNHANDLED' || error.code === 'E_NO_HANDLER'
  const message = error instanceof Error ? error.message : String(error)
  return /no handler registered|has no handler/i.test(message)
}

type Invoke = <T>(channel: string, payload?: unknown) => Promise<T>

export interface LoraProfilesClient {
  /** Empty when the channel is missing or fails: profiles are an extra, never a blocker. */
  list(): Promise<Record<string, LoraProfile>>
  save(input: LoraProfileSaveInput): Promise<LoraProfile>
  /** `null` when this build cannot read the file header. */
  inspect(input: { loraId: string; path?: string }): Promise<LoraInspectResult | null>
}

export function createLoraProfilesClient(invoke: Invoke = call): LoraProfilesClient {
  return {
    async list() {
      try {
        return normalizeLoraProfiles(await invoke<unknown>(Ipc.loraProfilesList))
      } catch {
        return {}
      }
    },
    async save(input) {
      let result: unknown
      try {
        result = await invoke<unknown>(Ipc.loraProfilesSave, input)
      } catch (error) {
        if (isMissingChannel(error)) throw new Error('这个版本的 MossStudio 还不能保存 LoRA 触发词', { cause: error })
        throw error
      }
      // An older handler may answer only `true`; what was sent is then what is stored.
      return normalizeLoraProfile(result, input.loraId) ?? normalizeLoraProfile(input, input.loraId)!
    },
    async inspect(input) {
      const payload = {
        ...(input.path?.trim() ? { filePath: input.path.trim() } : {}),
        ...(input.loraId?.trim() ? { loraId: input.loraId.trim() } : {}),
      }
      if (!payload.filePath && !payload.loraId) return null
      try {
        return normalizeInspect(await invoke<unknown>(Ipc.loraProfilesInspect, payload), input.loraId)
      } catch (error) {
        if (isMissingChannel(error)) return null
        throw error
      }
    },
  }
}

type Listener = () => void

/**
 * One shared copy for the picker, the params panel and prompt compilation, so a
 * trigger saved in one place shows everywhere without another round trip.
 */
export function createLoraProfileStore(
  client: LoraProfilesClient = createLoraProfilesClient(),
  publish: (profiles: LoraProfileMap) => void = () => {},
) {
  let profiles: LoraProfileMap = {}
  let loading: Promise<void> | null = null
  let loaded = false
  let requestSeq = 0
  const listeners = new Set<Listener>()
  const emit = (): void => {
    publish(profiles)
    listeners.forEach((listener) => listener())
  }

  return {
    getSnapshot: (): LoraProfileMap => profiles,
    subscribe(listener: Listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    loaded: (): boolean => loaded,
    load(force = false): Promise<void> {
      if (loading && !force) return loading
      if (loaded && !force) return Promise.resolve()
      const seq = ++requestSeq
      const task = client
        .list()
        .then((next) => {
          if (seq !== requestSeq) return
          profiles = next
          loaded = true
          emit()
        })
        .finally(() => {
          if (loading === task) loading = null
        })
      loading = task
      return task
    },
    async save(input: LoraProfileSaveInput): Promise<LoraProfile> {
      const saved = await client.save(input)
      requestSeq++
      profiles = { ...profiles, [saved.loraId]: { ...profiles[saved.loraId], ...saved } }
      emit()
      return saved
    },
    inspect: (input: { loraId: string; path?: string }) => client.inspect(input),
    /** Tests and a project reload start from a clean slate. */
    reset(next: LoraProfileMap = {}): void {
      requestSeq++
      profiles = next
      loaded = false
      loading = null
      emit()
    },
  }
}

export type LoraProfileStore = ReturnType<typeof createLoraProfileStore>

/** The app's store; it also feeds prompt compilation so 自动前置 / 自动后置 apply on every run. */
export const loraProfileStore: LoraProfileStore = createLoraProfileStore(createLoraProfilesClient())

let subscribedExternalRefresh = false
function ensureExternalRefreshSubscription(): void {
  if (subscribedExternalRefresh) return
  subscribedExternalRefresh = true
  try {
    onEvent(Events.loraProfilesChanged, () => {
      void loraProfileStore.load(true)
    })
  } catch {
    // Non-browser test environments may not expose window.clover.
  }
}

/** The profiles, loaded on first use and refreshed whenever MCP or IPC saves LoRA metadata. */
export function useLoraProfiles(store: LoraProfileStore = loraProfileStore): LoraProfileMap {
  const profiles = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useEffect(() => {
    if (store === loraProfileStore) ensureExternalRefreshSubscription()
    void store.load()
  }, [store])
  return profiles
}
