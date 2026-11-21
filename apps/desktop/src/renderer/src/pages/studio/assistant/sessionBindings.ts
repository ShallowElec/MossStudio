import type { AgentSession } from './collabClient'

/**
 * Which Agent conversations belong to a Studio project. An Agent lists every
 * conversation it has, across all its folders; the picker shows only the ones
 * this project started or the person chose for it, and offers the rest grouped
 * by working folder. The binding is per Agent and per project and lives in
 * localStorage when the Agent can resume conversations after a restart, else
 * for this run only: losing it only hides conversations, never deletes them.
 */

export interface ProjectSessionBinding {
  /** The conversation the panel shows; empty when none was chosen yet. */
  currentId: string
  /** Conversations kept in this project's list, oldest first. */
  pinnedIds: string[]
}

export interface WorkspaceGroup {
  /** Grouping key: the folder with `/` separators, no trailing slash, case-folded. Empty for no folder. */
  key: string
  /** The folder as the Agent reported it (first one seen). */
  cwd: string
  /** The folder's last segment, or 未指定工作区. */
  label: string
  sessions: AgentSession[]
  /** The newest `updatedAt` in the group. */
  updatedAt: number
}

const MAX_PINNED = 50
const NO_WORKSPACE = '未指定工作区'

function projectPart(projectKey: string | null): string {
  return projectKey || 'unsaved'
}

/** The conversation last shown for a project (kept from before pins existed). */
export function sessionBindingKey(backendId: string, projectKey: string | null): string {
  return `mossstudio.collab.session.${backendId}.${projectPart(projectKey)}`
}

export function pinnedSessionsKey(backendId: string, projectKey: string | null): string {
  return `mossstudio.collab.pinned.${backendId}.${projectPart(projectKey)}`
}

/** Agents whose conversations outlive a restart (`AgentBackendInfo.resumable`). */
const resumable = new Set<string>()

/**
 * Whether `backendId` can load its conversations again after a restart. Only
 * then is a binding kept in localStorage; otherwise it lasts for this run
 * (sessionStorage), so a reopened app never lists conversations that are gone.
 */
export function setSessionsResumable(backendId: string, value: boolean): void {
  if (value) resumable.add(backendId)
  else resumable.delete(backendId)
}

function storageFor(key: string): Storage {
  const backendId = /^mossstudio\.collab\.(?:session|pinned)\.([^.]+)\./.exec(key)?.[1] ?? ''
  return resumable.has(backendId) ? localStorage : sessionStorage
}

function readItem(key: string): string | null {
  try {
    return storageFor(key).getItem(key)
  } catch {
    return null
  }
}

function writeItem(key: string, value: string | null): void {
  try {
    const storage = storageFor(key)
    if (value === null || value === '') storage.removeItem(key)
    else storage.setItem(key, value)
  } catch {
    // Remembering the binding is a convenience only.
  }
}

function uniqueIds(values: readonly unknown[]): string[] {
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) seen.add(value)
  }
  return [...seen].slice(-MAX_PINNED)
}

function readPinned(backendId: string, projectKey: string | null): string[] | null {
  const raw = readItem(pinnedSessionsKey(backendId, projectKey))
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? uniqueIds(parsed) : []
  } catch {
    return []
  }
}

/**
 * The project's binding. A project remembered before pins existed has only a
 * current conversation: it becomes the first pin, so nothing disappears.
 */
export function readSessionBinding(backendId: string, projectKey: string | null): ProjectSessionBinding {
  const currentId = readItem(sessionBindingKey(backendId, projectKey)) ?? ''
  const pinned = readPinned(backendId, projectKey) ?? []
  return { currentId, pinnedIds: currentId && !pinned.includes(currentId) ? [...pinned, currentId] : pinned }
}

function writePinned(backendId: string, projectKey: string | null, ids: readonly string[]): void {
  writeItem(pinnedSessionsKey(backendId, projectKey), JSON.stringify(uniqueIds(ids)))
}

/** Show `sessionId` for this project and keep it in the project's list. */
export function bindSession(backendId: string, projectKey: string | null, sessionId: string): ProjectSessionBinding {
  const { pinnedIds } = readSessionBinding(backendId, projectKey)
  const next = uniqueIds([...pinnedIds, sessionId])
  writePinned(backendId, projectKey, next)
  writeItem(sessionBindingKey(backendId, projectKey), sessionId)
  return { currentId: sessionId, pinnedIds: next }
}

/**
 * Bind a conversation just made: to the project it was made for. The open
 * project's binding changes only when that is the open project.
 */
export function bindNewSession(
  backendId: string,
  openProject: string | null,
  forProject: string | undefined,
  sessionId: string,
): ProjectSessionBinding {
  if (forProject && forProject !== openProject) {
    bindSession(backendId, forProject, sessionId)
    return readSessionBinding(backendId, openProject)
  }
  return bindSession(backendId, openProject, sessionId)
}

/** Take `sessionId` out of the project's list; the conversation itself stays with the Agent. */
export function unbindSession(backendId: string, projectKey: string | null, sessionId: string): ProjectSessionBinding {
  const binding = readSessionBinding(backendId, projectKey)
  const pinnedIds = binding.pinnedIds.filter((id) => id !== sessionId)
  const currentId = binding.currentId === sessionId ? '' : binding.currentId
  writePinned(backendId, projectKey, pinnedIds)
  writeItem(sessionBindingKey(backendId, projectKey), currentId || null)
  return { currentId, pinnedIds }
}

/**
 * The binding for `projectKey`, taking over `from` when that project has none
 * yet: a project saved for the first time keeps the conversations it had while
 * it was unsaved.
 */
export function adoptSessionBinding(backendId: string, projectKey: string | null, from: ProjectSessionBinding): ProjectSessionBinding {
  const existing = readSessionBinding(backendId, projectKey)
  if (existing.pinnedIds.length || (!from.pinnedIds.length && !from.currentId)) return existing
  writePinned(backendId, projectKey, from.pinnedIds)
  writeItem(sessionBindingKey(backendId, projectKey), from.currentId || null)
  return readSessionBinding(backendId, projectKey)
}

/** The project's conversations the Agent still has, in pin order. */
export function projectSessions(sessions: readonly AgentSession[], pinnedIds: readonly string[]): AgentSession[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  return pinnedIds.map((id) => byId.get(id)).filter((session): session is AgentSession => session !== undefined)
}

export function workspaceKey(cwd: string | undefined): string {
  if (!cwd?.trim()) return ''
  const normalized = cwd.trim().replace(/\\/g, '/')
  const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
  // Windows folders differ only in case; POSIX ones rarely do in practice.
  return (trimmed || normalized).toLowerCase()
}

function workspaceLabel(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) ?? cwd
}

/**
 * Every conversation grouped by its working folder, newest folder first and
 * newest conversation first inside it; conversations without a folder last.
 */
export function groupByWorkspace(sessions: readonly AgentSession[]): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>()
  for (const session of sessions) {
    const key = workspaceKey(session.cwd)
    let group = groups.get(key)
    if (!group) {
      const cwd = key ? session.cwd!.trim() : ''
      group = { key, cwd, label: key ? workspaceLabel(cwd) : NO_WORKSPACE, sessions: [], updatedAt: 0 }
      groups.set(key, group)
    }
    group.sessions.push(session)
    group.updatedAt = Math.max(group.updatedAt, session.updatedAt ?? 0)
  }
  const newest = (a: AgentSession, b: AgentSession): number => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  return [...groups.values()]
    .map((group) => ({ ...group, sessions: [...group.sessions].sort(newest) }))
    .sort((a, b) => Number(!a.key) - Number(!b.key) || b.updatedAt - a.updatedAt || a.label.localeCompare(b.label))
}
