import type { ProjectCanvas } from '@shared/types'
import { linksOf } from './links'
import { sameData } from './sameData'

/**
 * Undo and redo for the board. A step keeps the canvases one gesture changed,
 * as they were before and after it, and undo puts back only the fields that
 * step changed. Whatever a run writes (its job, progress and pictures) is never
 * part of a step, so a job that finished in between stays finished. Pure, no
 * React; `useStudioProject` records into it at its one write path.
 */

/** Fields a run writes, and which picture a 画面 shows: undo leaves them as they are now. */
const RUN_FIELDS: ReadonlySet<string> = new Set<keyof ProjectCanvas>(['jobId', 'jobState', 'progress', 'outputs', 'error', 'shownOutput'])

export const HISTORY_LIMIT = 100

export interface HistoryStep {
  id: number
  /** Edits that arrive with the same token join this step: one gesture, one visit to a field, one assistant turn. */
  token: string
  /** Named by the caller; otherwise read from the change (`stepLabel`). */
  label?: string
  /** Each canvas the step touched, as it was before the step (`null`: it did not exist) and after it. */
  before: Map<string, ProjectCanvas | null>
  after: Map<string, ProjectCanvas | null>
  /** Where each canvas sat in the list before and after, so one brought back returns to its place (filmstrip order). */
  beforeAt: Map<string, number>
  afterAt: Map<string, number>
  selectedBefore: string | null
  selectedAfter: string | null
  /** Assistant tool calls whose changes are in this step. */
  calls: string[]
}

export interface BoardHistory {
  undo: HistoryStep[]
  redo: HistoryStep[]
  /** After an undo or redo nothing joins the step on top; the next edit starts a new one. */
  sealed: boolean
  nextId: number
}

export function createHistory(): BoardHistory {
  return { undo: [], redo: [], sealed: false, nextId: 1 }
}

/** The fields that differ between two versions of a canvas, run fields left out. */
export function changedFields(a: ProjectCanvas, b: ProjectCanvas): string[] {
  if (a === b) return []
  const left = a as unknown as Record<string, unknown>
  const right = b as unknown as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...keys].filter((key) => !RUN_FIELDS.has(key) && !sameData(left[key], right[key]))
}

export interface CanvasChange {
  id: string
  before: ProjectCanvas | null
  after: ProjectCanvas | null
  beforeAt: number
  afterAt: number
}

/**
 * The canvases that changed between two lists. Unchanged canvases keep their
 * object, so most are skipped by identity; a canvas whose only change is run
 * state does not count.
 */
export function diffCanvases(previous: readonly ProjectCanvas[], next: readonly ProjectCanvas[]): CanvasChange[] {
  if (previous === next) return []
  const at = new Map(previous.map((canvas, index) => [canvas.id, index]))
  const changes: CanvasChange[] = []
  const kept = new Set<string>()
  next.forEach((canvas, afterAt) => {
    kept.add(canvas.id)
    const beforeAt = at.get(canvas.id)
    if (beforeAt === undefined) {
      changes.push({ id: canvas.id, before: null, after: canvas, beforeAt: -1, afterAt })
      return
    }
    const before = previous[beforeAt]!
    if (before !== canvas && changedFields(before, canvas).length) changes.push({ id: canvas.id, before, after: canvas, beforeAt, afterAt })
  })
  previous.forEach((canvas, beforeAt) => {
    if (!kept.has(canvas.id)) changes.push({ id: canvas.id, before: canvas, after: null, beforeAt, afterAt: -1 })
  })
  return changes
}

export interface RecordOptions {
  token: string
  label?: string
  /** An assistant tool call that made this change. */
  call?: string
  selected: string | null
}

/**
 * Add an edit to the history: it joins the step on top when it carries the
 * same token, otherwise it starts a new step and clears what could be redone.
 * Returns true when the steps changed shape (a new step, redo cleared).
 */
export function record(history: BoardHistory, changes: readonly CanvasChange[], options: RecordOptions): boolean {
  if (!changes.length) return false
  const top = history.undo.at(-1)
  let step = top && !history.sealed && top.token === options.token ? top : null
  const shaped = !step
  if (!step) {
    step = {
      id: history.nextId++,
      token: options.token,
      before: new Map(),
      after: new Map(),
      beforeAt: new Map(),
      afterAt: new Map(),
      selectedBefore: options.selected,
      selectedAfter: null,
      calls: [],
    }
    history.undo.push(step)
    if (history.undo.length > HISTORY_LIMIT) history.undo.splice(0, history.undo.length - HISTORY_LIMIT)
    history.redo = []
  }
  history.sealed = false
  for (const change of changes) {
    if (!step.before.has(change.id)) {
      step.before.set(change.id, change.before)
      step.beforeAt.set(change.id, change.beforeAt)
    }
    step.after.set(change.id, change.after)
    step.afterAt.set(change.id, change.afterAt)
  }
  if (options.label && !step.label) step.label = options.label
  if (options.call && !step.calls.includes(options.call)) step.calls.push(options.call)
  return shaped
}

/** A step whose edits cancel out (a box dragged back to where it was). */
export function isEmptyStep(step: HistoryStep): boolean {
  for (const [id, before] of step.before) {
    const after = step.after.get(id) ?? null
    if (!before !== !after) return false
    if (before && after && changedFields(before, after).length) return false
  }
  return true
}

/** A result with pictures: undo never takes one off the board. */
function keepsPictures(canvas: ProjectCanvas): boolean {
  return canvas.kind === 'result' && Boolean(canvas.outputs?.length)
}

/**
 * Apply a step to the canvases as they are now, backwards (undo) or forwards
 * (redo). Only the fields the step changed are written, onto the current
 * canvas, so run state and later edits to other fields stay. A canvas the step
 * removed comes back at its old place; one it added goes again.
 */
export function applyStep(
  canvases: readonly ProjectCanvas[],
  step: HistoryStep,
  direction: 'undo' | 'redo',
): { canvases: ProjectCanvas[]; restored: string[] } {
  const from = direction === 'undo' ? step.after : step.before
  const to = direction === 'undo' ? step.before : step.after
  const places = direction === 'undo' ? step.beforeAt : step.afterAt
  const list = [...canvases]
  const index = new Map(list.map((canvas, at) => [canvas.id, at]))
  const removed = new Set<string>()
  const inserts: Array<{ at: number; canvas: ProjectCanvas }> = []
  for (const [id, target] of to) {
    const at = index.get(id)
    const current = at === undefined ? undefined : list[at]
    const source = from.get(id) ?? null
    if (!target) {
      if (current && !(direction === 'undo' && keepsPictures(current))) removed.add(id)
      continue
    }
    if (!current) {
      // Only a canvas this step removed comes back; one removed since by something else stays gone.
      if (!source) inserts.push({ at: places.get(id) ?? list.length, canvas: target })
      continue
    }
    const fields = source ? changedFields(source, target) : changedFields(current, target)
    if (!fields.length) continue
    const next = { ...current } as unknown as Record<string, unknown>
    const values = target as unknown as Record<string, unknown>
    for (const key of fields) {
      if (values[key] === undefined) delete next[key]
      else next[key] = values[key]
    }
    list[at!] = next as unknown as ProjectCanvas
  }
  const result = removed.size ? list.filter((canvas) => !removed.has(canvas.id)) : list
  inserts.sort((a, b) => a.at - b.at)
  for (const { at, canvas } of inserts) result.splice(Math.min(at, result.length), 0, canvas)
  return { canvases: result, restored: inserts.map((item) => item.canvas.id) }
}

/** Board cards, not the runs that live in a filmstrip. */
function cardsOf(list: readonly ProjectCanvas[]): ProjectCanvas[] {
  return list.filter((canvas) => canvas.kind !== 'result')
}

function named(list: readonly ProjectCanvas[], verb: string): string {
  return list.length === 1 ? `${verb}${list[0]!.title}` : `${verb} ${list.length} 张卡片`
}

const within = (fields: ReadonlySet<string>, allowed: readonly string[]): boolean => [...fields].every((field) => allowed.includes(field))

/**
 * A short name for what a step did, for the toast after undo or redo:
 * 移动画面 2, 删除 3 张卡片, 改描述 · 画面 1, 连线 · 画面 2.
 */
export function stepLabel(step: HistoryStep): string {
  if (step.label) return step.label
  const entries = [...step.before].map(([id, before]) => ({ before, after: step.after.get(id) ?? null }))
  const removed = entries.flatMap((entry) => (entry.before && !entry.after ? [entry.before] : []))
  if (removed.length) {
    const cards = cardsOf(removed)
    return cards.length ? named(cards, '删除') : '删除这次生成'
  }
  const added = entries.flatMap((entry) => (!entry.before && entry.after ? [entry.after] : []))
  if (added.length) {
    const cards = cardsOf(added)
    const shown = cards.length ? cards : added
    return named(shown, shown.every((canvas) => canvas.kind === 'image') ? '添加' : '新建')
  }
  const edited = entries.flatMap((entry) => (entry.before && entry.after ? [{ before: entry.before, after: entry.after }] : []))
  const fields = new Set(edited.flatMap((entry) => changedFields(entry.before, entry.after)))
  const one = edited.length === 1 ? edited[0]!.after : null
  const onto = (verb: string): string => (one ? `${verb} · ${one.title}` : verb)
  if (within(fields, ['x', 'y']))
    return named(
      edited.map((entry) => entry.after),
      '移动',
    )
  if (within(fields, ['pinned', 'x', 'y'])) return edited.some((entry) => entry.after.pinned) ? '固定到画板' : '收回到画面'
  if (within(fields, ['prompt', 'summary'])) return onto('改描述')
  if (within(fields, ['layers'])) return onto('改区域')
  if (fields.has('inputs')) {
    const count = (side: 'before' | 'after'): number => edited.reduce((sum, entry) => sum + linksOf(entry[side]).length, 0)
    const linked = count('after') - count('before')
    if (linked > 0) return onto('连线')
    if (linked < 0) return onto('删除连线')
    const maskOnly = edited.every((entry) => {
      const { mask: _before, ...restBefore } = entry.before.inputs ?? {}
      const { mask: _after, ...restAfter } = entry.after.inputs ?? {}
      return sameData(restBefore, restAfter)
    })
    return onto(maskOnly ? '改遮罩' : '改输入')
  }
  if (within(fields, ['width', 'height', 'layers', 'baseSize'])) return onto('改大小')
  if (within(fields, ['backgroundPath'])) return edited.some((entry) => entry.after.backgroundPath) ? onto('描图') : onto('不用描图')
  if (within(fields, ['title'])) return onto('改名')
  if (within(fields, ['adapters'])) return onto('改 LoRA')
  return onto('改设置')
}

/** Where an assistant turn's changes stand in the history, for its 撤销这一步 button. */
export type TurnState =
  /** Its steps are the latest: undo takes back exactly them. */
  | 'latest'
  /** Later changes sit on top of it; undoing it alone would take those too. */
  | 'buried'
  /** Undone, and redo would bring back exactly them. */
  | 'redo'
  /** Undone, with other steps undone since. */
  | 'undone'

function ofTurn(step: HistoryStep, calls: ReadonlySet<string>): boolean {
  return step.calls.some((call) => calls.has(call))
}

/** How many steps on top of `stack` belong to the turn, or -1 when one of its steps sits lower down. */
function topRun(stack: readonly HistoryStep[], calls: ReadonlySet<string>): number {
  let count = 0
  while (count < stack.length && ofTurn(stack[stack.length - 1 - count]!, calls)) count += 1
  return stack.slice(0, stack.length - count).some((step) => ofTurn(step, calls)) ? -1 : count
}

/** `null` when no step holds the turn's changes (it changed nothing, or the history was cleared). */
export function turnState(history: BoardHistory, calls: readonly string[]): TurnState | null {
  if (!calls.length) return null
  const set = new Set(calls)
  if (history.undo.some((step) => ofTurn(step, set))) return topRun(history.undo, set) > 0 ? 'latest' : 'buried'
  if (history.redo.some((step) => ofTurn(step, set))) return topRun(history.redo, set) > 0 ? 'redo' : 'undone'
  return null
}

/** How many undo (or redo) steps take back (or bring back) exactly that turn; 0 when they would take more. */
export function turnSteps(history: BoardHistory, calls: readonly string[], direction: 'undo' | 'redo'): number {
  const count = topRun(direction === 'undo' ? history.undo : history.redo, new Set(calls))
  return Math.max(0, count)
}
