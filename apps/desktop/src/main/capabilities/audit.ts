import { appendFile, mkdir, open, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CapabilityAuditEntry, CapabilityAuditQuery } from '@shared/capabilities'
import { paths } from '../lib/paths'

/**
 * Capability execution audit trail (操作留痕).
 *
 * Every call through the main dispatcher appends one JSON line to
 * `<dataRoot>/logs/capabilities.jsonl` off the main thread, and stays in a
 * bounded memory buffer. The file is rotated once it reaches `MAX_FILE_BYTES`
 * (one previous file is kept), and only its tail is read back.
 */

const MAX_MEMORY_ENTRIES = 500
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
export const MAX_AUDIT_FILE_BYTES = 2 * 1024 * 1024
/** How much of the file's end is read back after a restart. */
const TAIL_BYTES = 256 * 1024

const memoryEntries: CapabilityAuditEntry[] = []
let writes: Promise<void> = Promise.resolve()
let loaded: Promise<void> | null = null

async function appendLine(file: string, line: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const size = (await stat(file).catch(() => null))?.size ?? 0
  if (size > 0 && size + Buffer.byteLength(line) > MAX_AUDIT_FILE_BYTES) await rename(file, `${file}.1`)
  await appendFile(file, line, 'utf8')
}

/** The entries written before this run: the complete lines of the file's last `TAIL_BYTES`. */
async function readTail(): Promise<CapabilityAuditEntry[]> {
  const file = paths.capabilityAudit()
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    // No log yet: nothing to read back.
    return []
  }
  try {
    const size = (await handle.stat()).size
    const start = Math.max(0, size - TAIL_BYTES)
    const buffer = Buffer.alloc(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    const lines = buffer.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    const parsed: CapabilityAuditEntry[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        parsed.push(JSON.parse(line) as CapabilityAuditEntry)
      } catch {
        // A truncated line after an abrupt quit is skipped.
      }
    }
    return parsed
  } catch {
    // Unreadable log: the history starts empty rather than failing the caller.
    return []
  } finally {
    await handle.close()
  }
}

function ensureLoaded(): Promise<void> {
  loaded ??= readTail().then((earlier) => {
    const known = new Set(memoryEntries.map((entry) => entry.id))
    memoryEntries.unshift(...earlier.filter((entry) => !known.has(entry.id)))
    if (memoryEntries.length > MAX_MEMORY_ENTRIES) memoryEntries.splice(0, memoryEntries.length - MAX_MEMORY_ENTRIES)
  })
  return loaded
}

export function recordCapabilityAudit(entry: CapabilityAuditEntry): void {
  memoryEntries.push(entry)
  if (memoryEntries.length > MAX_MEMORY_ENTRIES) memoryEntries.splice(0, memoryEntries.length - MAX_MEMORY_ENTRIES)
  const line = `${JSON.stringify(entry)}\n`
  // The file is named now: the write itself happens later, off the main thread.
  const file = paths.capabilityAudit()
  writes = writes
    .then(() => appendLine(file, line))
    .catch((error: unknown) => console.warn('[capabilities-audit]', error instanceof Error ? error.message : String(error)))
}

/** Resolves once every recorded entry is on disk. */
export function flushCapabilityAudit(): Promise<void> {
  return writes
}

export async function listCapabilityAudit(query: CapabilityAuditQuery = {}): Promise<CapabilityAuditEntry[]> {
  await ensureLoaded()
  const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT))
  const filtered = memoryEntries.filter((entry) => {
    if (query.source && entry.source !== query.source) return false
    if (query.conversationId && entry.conversationId !== query.conversationId) return false
    if (query.packId && entry.packId !== query.packId) return false
    if (query.actionId && entry.actionId !== query.actionId) return false
    return true
  })
  return filtered.slice(-limit).reverse()
}

export function resetCapabilityAuditMemory(): void {
  memoryEntries.length = 0
  loaded = null
}
