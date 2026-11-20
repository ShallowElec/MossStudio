import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Events } from '@shared/channels'
import type { ControlAdapterEntry } from '@shared/types'
import { codedError } from '../lib/codedError'
import { emit } from '../lib/events'
import { paths } from '../lib/paths'
import { sharedControlAdapters } from './modelSources'

/**
 * Control adapter files the person imported (模型 › 导入模型). Each file is
 * checked with the engine's `inspect` before it is listed (services/modelImport.ts),
 * so only what the engine itself calls a control adapter can be picked for a job.
 */

function registryFile(): string {
  return join(paths.root(), 'control-adapters.json')
}

function isEntry(value: unknown): value is ControlAdapterEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry['id'] === 'string' &&
    typeof entry['path'] === 'string' &&
    typeof entry['name'] === 'string' &&
    typeof entry['sizeBytes'] === 'number' &&
    Array.isArray(entry['controlKinds']) &&
    (entry['controlKinds'] as unknown[]).every((kind) => typeof kind === 'string') &&
    typeof entry['addedAt'] === 'string'
  )
}

function registeredControlAdapters(): ControlAdapterEntry[] {
  try {
    const raw = JSON.parse(readFileSync(registryFile(), 'utf8')) as unknown
    return Array.isArray(raw) ? raw.filter(isEntry) : []
  } catch {
    return []
  }
}

export function listControlAdapters(): ControlAdapterEntry[] {
  const registered = registeredControlAdapters()
  return [...registered, ...sharedControlAdapters().filter((entry) => !registered.some((item) => item.path === entry.path))]
}

function writeRegistry(entries: ControlAdapterEntry[]): void {
  const file = registryFile()
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(entries, null, 2), 'utf8')
  renameSync(temporary, file)
}

/**
 * Adds a file the engine's `inspect` called a loadable control adapter, with the
 * kinds and base model it reported. Adding the same file again, also through a
 * link, updates its one entry.
 */
export function registerControlAdapter(input: { path: string; controlKinds: string[]; baseModel?: string }): ControlAdapterEntry {
  let path: string
  let sizeBytes: number
  try {
    path = realpathSync.native(input.path)
    const info = statSync(path)
    if (!info.isFile()) throw new Error('not a file')
    sizeBytes = info.size
  } catch {
    throw codedError('E_INPUT_PATH', '找不到这个文件，请重新选择')
  }
  const existing = registeredControlAdapters()
  const previous = existing.find((entry) => entry.path === path)
  const entry: ControlAdapterEntry = {
    id: previous?.id ?? `control-${createHash('sha1').update(path).digest('hex').slice(0, 12)}`,
    name: basename(path),
    path,
    sizeBytes,
    controlKinds: input.controlKinds,
    ...(input.baseModel ? { baseModel: input.baseModel } : {}),
    addedAt: previous?.addedAt ?? new Date().toISOString(),
  }
  writeRegistry([...existing.filter((item) => item.path !== path), entry])
  emit(Events.modelsChanged, null)
  return entry
}

export function removeControlAdapter(input: { id: string }): null {
  const existing = registeredControlAdapters()
  const next = existing.filter((entry) => entry.id !== input.id)
  if (next.length !== existing.length) {
    writeRegistry(next)
    emit(Events.modelsChanged, null)
  }
  return null
}
