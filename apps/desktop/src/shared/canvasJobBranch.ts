import type { JobRecord, ProjectCanvas } from './types'

const ACTIVE_STATES = new Set(['queued', 'starting', 'running'])

/** Runs of one canvas that may wait behind the one it is drawing; main and the Studio both hold to it. */
export const MAX_QUEUED_RUNS = 8

export interface CanvasBranch {
  sourceId: string
  path: ReadonlySet<string>
}

/**
 * Two runs that must not overlap: one starts from a canvas in the other's
 * lineage. Runs started from the same canvas do not conflict; each draws
 * into a result of its own, so they wait their turn in the engine's queue.
 */
export function canvasBranchesConflict(first: CanvasBranch, second: CanvasBranch): boolean {
  if (first.sourceId === second.sourceId) return false
  return first.path.has(second.sourceId) || second.path.has(first.sourceId)
}

function isActive(canvas: ProjectCanvas, jobs: readonly JobRecord[]): boolean {
  const job = canvas.jobId ? jobs.find((item) => item.id === canvas.jobId) : undefined
  return ACTIVE_STATES.has(job?.state ?? canvas.jobState ?? '')
}

export function activeCanvasBranchIds(canvases: ProjectCanvas[], jobs: JobRecord[]): Set<string> {
  const byId = new Map(canvases.map((canvas) => [canvas.id, canvas]))
  const busy = new Set<string>()
  for (const active of canvases.filter((canvas) => isActive(canvas, jobs))) {
    for (const id of canvasLineage(active, byId)) busy.add(id)
  }
  return busy
}

/**
 * Canvases a new run cannot start on yet: one in the lineage of an active run
 * that was started from another canvas, as main checks it. A canvas whose own
 * runs are going is not blocked; another run queues behind them.
 */
export function blockedCanvasIds(canvases: ProjectCanvas[], jobs: JobRecord[]): Set<string> {
  const byId = new Map(canvases.map((canvas) => [canvas.id, canvas]))
  // A result runs as its source's job (main gets the source's lineage); an older 画面 that ran itself is its own source.
  const branches = canvases
    .filter((canvas) => isActive(canvas, jobs))
    .map((run) => ({
      sourceId: run.kind === 'result' ? (run.sourceCanvasId ?? run.id) : run.id,
      path: new Set(canvasLineage(run, byId)),
    }))
  const blocked = new Set<string>()
  if (!branches.length) return blocked
  for (const canvas of canvases) {
    const next = { sourceId: canvas.id, path: new Set(canvasLineage(canvas, byId)) }
    if (branches.some((branch) => canvasBranchesConflict(next, branch))) blocked.add(canvas.id)
  }
  return blocked
}

export function canvasLineage(canvas: ProjectCanvas, canvases: ProjectCanvas[] | ReadonlyMap<string, ProjectCanvas>): string[] {
  const byId = Array.isArray(canvases) ? new Map(canvases.map((item) => [item.id, item])) : canvases
  const lineage: string[] = []
  let current: ProjectCanvas | undefined = canvas
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    lineage.push(current.id)
    current = current.sourceCanvasId ? byId.get(current.sourceCanvasId) : undefined
  }
  return lineage
}
