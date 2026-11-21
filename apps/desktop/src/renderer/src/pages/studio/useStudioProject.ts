import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JobRecord, ProjectCanvas, ProjectDocument, ProjectSummary } from '@shared/types'
import { electronStudioClient, type StudioClient } from '../../lib/studioClient'
import { applyJobs, copyAsLayout, createLayoutCanvas, migrateCanvases, removeCanvasFrom, settingsFrom } from './canvases'
import {
  applyStep,
  createHistory,
  diffCanvases,
  heldMasks,
  isEmptyStep,
  isTurnStep,
  liveSteps,
  mergeChanges,
  record,
  removesRunning,
  stepLabel,
  turnState,
  type CanvasChange,
  type HistoryStep,
  type TurnState,
} from './history'
import { foldedRunIds, withoutUnstartedRuns } from './runs'
import { UNTITLED_PROJECT, nextProjectName } from './defaults'
import { useLiveState } from './useLiveState'

const AUTOSAVE_DELAY_MS = 1200

/** What decides whether the project on disk is up to date. */
function snapshotOf(name: string, canvases: readonly ProjectCanvas[], selectedCanvasId: string | null): string {
  return JSON.stringify({ name, canvases, selectedCanvasId })
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

type CanvasesUpdate = ProjectCanvas[] | ((previous: ProjectCanvas[]) => ProjectCanvas[])

/** A change the history should treat as one step, whenever it lands: an assistant turn. */
export interface StepGroup {
  key: string
  label: string
  /** The assistant tool call that makes this change. */
  call?: string
}

/**
 * What an undo or redo did: the step's name and id, `'running'` when it would
 * take off a card whose run is still going (nothing changed), or null when
 * there was nothing to do.
 */
export type StepOutcome = { label: string; id: number } | 'running' | null

/** Undo and redo of the board's canvases (see history.ts). */
export interface StudioHistory {
  canUndo: boolean
  canRedo: boolean
  /** Bumped whenever the steps change shape, so views that read `turn` render again. */
  version: number
  /** Takes back the latest step; with `only`, just while that step is the latest. */
  undo: (only?: number) => StepOutcome
  redo: (only?: number) => StepOutcome
  /** The id of the step undo (or redo) would take now, to tie a toast's button to it. */
  top: (direction: 'undo' | 'redo') => number | null
  /** Edits made while `run` runs (its synchronous part) join one step with the other edits of `group.key`. */
  within: <T>(group: StepGroup, run: () => T) => T
  /** Edits made while `run` runs join step `id`, if it is still the latest (the second half of an action that awaited). */
  join: <T>(id: number | null, run: () => T) => T
  /** Where the changes of an assistant turn, known by its tool calls, stand. */
  turn: (calls: readonly string[]) => TurnState | null
  /** Undo (or redo) exactly that turn's steps; null when other steps are in the way. */
  undoTurn: (calls: readonly string[]) => StepOutcome
  redoTurn: (calls: readonly string[]) => StepOutcome
}

function isFormField(element: Element | null): boolean {
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'))
}

/** The board before or after a call an external Agent made. */
export interface BoardState {
  canvases: readonly ProjectCanvas[]
  selectedId: string | null
  /** The project session (sessionKey); a call that opened or created a project leaves a different one. */
  session?: number
}

/** What the board should follow after an external Agent's call, and how to say it. */
export interface ExternalFocus {
  canvasId: string
  title: string
  change: 'added' | 'selected' | 'edited' | 'run'
}

/**
 * Where to look after an external Agent changed the board: a card it added
 * (the last 画面 among them), else a card it selected, else the open card when
 * it rewrote its description or regions. A run folded into a filmstrip is shown
 * through its 画面. Null when nothing the person would miss happened, or when
 * the call switched to another project: its cards were not made by the Agent.
 */
export function externalFocusOf(before: BoardState, after: BoardState): ExternalFocus | null {
  if (before.session !== undefined && after.session !== undefined && before.session !== after.session) return null
  const folded = foldedRunIds(after.canvases)
  const visible = (id: string | null | undefined): ProjectCanvas | null => {
    const card = id ? after.canvases.find((canvas) => canvas.id === id) : undefined
    if (!card) return null
    if (folded.has(card.id) && card.sourceCanvasId) return after.canvases.find((canvas) => canvas.id === card.sourceCanvasId) ?? card
    return card
  }
  const known = new Set(before.canvases.map((canvas) => canvas.id))
  const added = after.canvases.filter((canvas) => !known.has(canvas.id))
  const addedCard = visible([...added].reverse().find((canvas) => canvas.kind === 'layout')?.id ?? added.at(-1)?.id)
  if (addedCard && known.has(addedCard.id)) {
    // Only a run was added: it shows in the filmstrip of its 画面.
    return { canvasId: addedCard.id, title: addedCard.title, change: 'run' }
  }
  if (addedCard) return { canvasId: addedCard.id, title: addedCard.title, change: 'added' }
  if (after.selectedId && after.selectedId !== before.selectedId) {
    const card = visible(after.selectedId)
    if (card) return { canvasId: card.id, title: card.title, change: 'selected' }
  }
  const id = after.selectedId
  const was = id ? before.canvases.find((canvas) => canvas.id === id) : undefined
  const now = id ? after.canvases.find((canvas) => canvas.id === id) : undefined
  if (was && now && (was.prompt !== now.prompt || JSON.stringify(was.layers) !== JSON.stringify(now.layers))) {
    return { canvasId: now.id, title: now.title, change: 'edited' }
  }
  return null
}

/** The label of the undo step an external Agent's call makes. */
export const EXTERNAL_STEP_LABEL = '外部 Agent 的修改'

/**
 * One undo step per external Agent call, also for the edits it makes after an
 * await: `within` groups only what happens synchronously, so the board methods
 * an external call uses are wrapped to re-enter the step of the call in progress.
 */
export function createExternalSteps(within: StudioHistory['within']): {
  follow: <T>(call: string, run: () => Promise<T>) => Promise<T>
  wrap: <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A) => R
} {
  const active: StepGroup[] = []
  return {
    async follow(call, run) {
      const group: StepGroup = { key: `external:${call}`, label: EXTERNAL_STEP_LABEL, call }
      active.push(group)
      try {
        return await within(group, run)
      } finally {
        active.splice(active.indexOf(group), 1)
      }
    },
    wrap(fn) {
      return (...args) => {
        const group = active.at(-1)
        return group ? within(group, () => fn(...args)) : fn(...args)
      }
    },
  }
}

/** The toast line for what an external Agent just did on the board. */
export function externalFocusMessage(focus: ExternalFocus): string {
  if (focus.change === 'added') return `外部 Agent 新建了「${focus.title}」`
  if (focus.change === 'selected') return `外部 Agent 切到了「${focus.title}」`
  if (focus.change === 'run') return `外部 Agent 开始生成「${focus.title}」`
  return `外部 Agent 修改了「${focus.title}」`
}

export interface StudioProject {
  loaded: boolean
  /** Changes whenever another project is opened or a new one is started. */
  sessionKey: number
  projects: ProjectSummary[]
  projectId: string | null
  projectName: string
  canvases: ProjectCanvas[]
  canvasesRef: { readonly current: ProjectCanvas[] }
  selectedCanvasId: string | null
  selectedRef: { readonly current: string | null }
  selectedCanvas: ProjectCanvas | null
  saveStatus: SaveStatus
  saveError: string | null
  /** A user edit: saved, and one step of undo. `label` names the step when the change alone would not say it. */
  setCanvases: (next: CanvasesUpdate, label?: string) => void
  /** What a run writes (its result card, job id, seed): saved, but never a step of undo. */
  setRunCanvases: (next: CanvasesUpdate) => void
  updateCanvas: (id: string, patch: Partial<ProjectCanvas> | ((canvas: ProjectCanvas) => ProjectCanvas), label?: string) => void
  select: (id: string | null) => void
  addCanvas: (source?: ProjectCanvas) => ProjectCanvas
  /** Removes the canvas and every link that pointed at it; returns how many links went. */
  removeCanvas: (id: string) => number
  saveNow: (override?: { canvases: ProjectCanvas[]; selectedCanvasId: string | null }) => Promise<ProjectDocument | null>
  openProject: (id: string) => Promise<void>
  newProject: () => Promise<void>
  /** Saves an empty project under `name` without leaving the open one; its id, or null when the save failed. */
  createProject: (name: string) => Promise<string | null>
  rename: (name: string) => void
  deleteProject: (id: string) => Promise<void>
  history: StudioHistory
}

/**
 * The open project: its canvases, the selection, and persistence. Edits are
 * saved automatically shortly after they happen; Ctrl+S saves right away.
 * Saves run one after another, so a save started by a generation never races
 * the autosave timer.
 */
export function useStudioProject(options: {
  jobs: readonly JobRecord[]
  onError: (message: string) => void
  /** False while the Studio page is hidden; keyboard shortcuts are ignored then. */
  active?: boolean
  client?: StudioClient
}): StudioProject {
  const client = options.client ?? electronStudioClient
  const onErrorRef = useRef(options.onError)
  onErrorRef.current = options.onError

  const [loaded, setLoaded] = useState(false)
  const [sessionKey, setSessionKey] = useState(0)
  const activeRef = useRef(options.active !== false)
  activeRef.current = options.active !== false
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [projectId, setProjectId, projectIdRef] = useLiveState<string | null>(null)
  const [projectName, setProjectName, projectNameRef] = useLiveState(UNTITLED_PROJECT)
  const [canvases, setCanvases, canvasesRef] = useLiveState<ProjectCanvas[]>([])
  const [selectedCanvasId, setSelected, selectedRef] = useLiveState<string | null>(null)
  const [saving, setSaving] = useState(0)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** Series fields of projects made by older versions; kept as-is when saving. */
  const meta = useRef<{ seriesId?: string; page?: number }>({})
  const lastSaved = useRef('')
  /** Bumped on every project switch so a late save never writes into another project. */
  const token = useRef(0)
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * Counts edits made in this window (typing, drawing, selecting, adding…);
   * job progress copied onto canvases does not count. `savedEdits` is the
   * count the last successful save included. Only edits beyond it are worth
   * writing when the Studio unmounts or the window closes.
   */
  const edits = useRef(0)
  const savedEdits = useRef(0)
  /** `updatedAt` of the file as this window last read or wrote it. */
  const knownUpdatedAt = useRef<string | null>(null)
  const loadedRef = useRef(false)
  loadedRef.current = loaded
  const jobsRef = useRef(options.jobs)
  jobsRef.current = options.jobs

  const history = useRef(createHistory())
  const [historyShape, setHistoryShape] = useState({ canUndo: false, canRedo: false, version: 0 })
  const reshape = useCallback(() => {
    const { undo, redo } = history.current
    setHistoryShape((shape) => ({
      canUndo: liveSteps(undo).length > 0,
      canRedo: liveSteps(redo).length > 0,
      version: shape.version + 1,
    }))
  }, [])
  /** The assistant turn whose edits are being made right now. */
  const group = useRef<StepGroup | null>(null)
  /** Set while edits join an earlier step (`join`): that step's token. */
  const joining = useRef<string | null>(null)
  /** A pointer gesture's edits, held back until the pointer is let go: a drag records nothing while it moves. */
  const gesture = useRef<{ token: string; selected: string | null; changes: Map<string, CanvasChange> } | null>(null)
  const flushGesture = (): void => {
    const held = gesture.current
    gesture.current = null
    if (held && record(history.current, [...held.changes.values()], { token: held.token, selected: held.selected })) reshape()
  }
  const flushGestureRef = useRef(flushGesture)
  flushGestureRef.current = flushGesture
  /**
   * What makes edits one step when no turn groups them: one pointer gesture
   * (a box dragged or resized, a slider pulled), one visit to a form field
   * (typing a description is one step per focus, not per key), else one task
   * (a group of cards moved or deleted together).
   */
  const moment = useRef({ tick: 0, tickPending: false, gesture: 0, pressed: false, focus: 0, focused: null as EventTarget | null })
  useEffect(() => {
    const now = moment.current
    const down = (): void => {
      now.gesture += 1
      now.pressed = true
    }
    const up = (): void => {
      now.pressed = false
      flushGestureRef.current()
    }
    const focus = (event: FocusEvent): void => {
      // Coming back from another window focuses the same field again: still the same visit.
      if (event.target === now.focused) return
      now.focused = event.target
      now.focus += 1
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    window.addEventListener('blur', up)
    window.addEventListener('focusin', focus, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
      window.removeEventListener('blur', up)
      window.removeEventListener('focusin', focus, true)
    }
  }, [])
  const tokenNow = (): string => {
    const now = moment.current
    if (group.current) return `group:${group.current.key}`
    if (joining.current) return joining.current
    if (now.pressed) return `pointer:${now.gesture}`
    if (isFormField(document.activeElement)) return `field:${now.focus}`
    if (!now.tickPending) {
      now.tickPending = true
      queueMicrotask(() => {
        now.tick += 1
        now.tickPending = false
      })
    }
    return `tick:${now.tick}`
  }
  const note = (previous: ProjectCanvas[], next: ProjectCanvas[], label?: string): void => {
    const changes = diffCanvases(previous, next)
    if (!changes.length) return
    const turn = group.current
    const token = tokenNow()
    if (token.startsWith('pointer:') && !label) {
      if (gesture.current?.token !== token) {
        flushGesture()
        gesture.current = { token, selected: selectedRef.current, changes: new Map() }
      }
      mergeChanges(gesture.current.changes, changes)
      return
    }
    flushGesture()
    const options = { token, label: turn?.label ?? label, call: turn?.call, selected: selectedRef.current }
    if (record(history.current, changes, options)) reshape()
  }
  const noteRef = useRef(note)
  noteRef.current = note

  const snapshot = useMemo(() => snapshotOf(projectName, canvases, selectedCanvasId), [projectName, canvases, selectedCanvasId])
  const liveSnapshot = (): string => snapshotOf(projectNameRef.current, canvasesRef.current, selectedRef.current)
  const isDirty = (): boolean => liveSnapshot() !== lastSaved.current && (projectIdRef.current !== null || canvasesRef.current.length > 0)

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await client.listProjects())
    } catch {
      // The switcher keeps the previous list.
    }
  }, [client])

  const saveNow = useCallback(
    (override?: { canvases: ProjectCanvas[]; selectedCanvasId: string | null }) => {
      const queuedIn = token.current
      const run = async (): Promise<ProjectDocument | null> => {
        // Queued for a project that has since been closed or deleted.
        if (token.current !== queuedIn) return null
        const startedIn = token.current
        const id = projectIdRef.current
        const list = override?.canvases ?? canvasesRef.current
        const selected = override ? override.selectedCanvasId : selectedRef.current
        if (!id && list.length === 0) return null
        const name = projectNameRef.current.trim() || UNTITLED_PROJECT
        const sent = snapshotOf(projectNameRef.current, list, selected)
        const editsIncluded = edits.current
        setSaving((count) => count + 1)
        try {
          const held = heldMasks(history.current)
          const saved = await client.saveProject({
            id: id ?? undefined,
            name,
            canvases: list,
            selectedCanvasId: selected ?? undefined,
            seriesId: meta.current.seriesId,
            page: meta.current.page,
            ...(held.length ? { keepMasks: held } : {}),
          })
          if (token.current === startedIn) {
            setProjectId(saved.id)
            setSaveError(null)
            // Changed while the save was on its way (an undo back to what was saved before
            // sets no autosave timer, as it matches the old copy): write again.
            const live = snapshotOf(projectNameRef.current, canvasesRef.current, selectedRef.current)
            if (live !== sent) queueMicrotask(() => void saveAgain.current())
            lastSaved.current = sent
            savedEdits.current = Math.max(savedEdits.current, editsIncluded)
            knownUpdatedAt.current = saved.updatedAt ?? null
            // The main process copies underlay images into the project folder;
            // adopt those paths without discarding edits made during the save.
            const savedPaths = new Map((saved.canvases ?? []).map((canvas) => [canvas.id, canvas.backgroundPath]))
            const sentPaths = new Map(list.map((canvas) => [canvas.id, canvas.backgroundPath]))
            setCanvases((previous) => {
              let changed = false
              const next = previous.map((canvas) => {
                const persisted = savedPaths.get(canvas.id)
                if (persisted === undefined || persisted === canvas.backgroundPath) return canvas
                if (sentPaths.get(canvas.id) !== canvas.backgroundPath) return canvas
                changed = true
                return { ...canvas, backgroundPath: persisted }
              })
              return changed ? next : previous
            })
          }
          void refreshProjects()
          return saved
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (token.current === startedIn) setSaveError(message)
          onErrorRef.current(`项目没有保存成功：${message}`)
          return null
        } finally {
          setSaving((count) => count - 1)
        }
      }
      const result = chain.current.then(run, run)
      chain.current = result.catch(() => undefined)
      return result
    },
    [client, refreshProjects, setCanvases, setProjectId, canvasesRef, projectIdRef, projectNameRef, selectedRef],
  )
  const saveAgain = useRef(saveNow)
  saveAgain.current = saveNow

  /** Apply a loaded document (or a fresh one) as the open project. */
  const adopt = useCallback(
    (
      doc: {
        id: string | null
        name: string
        canvases: ProjectCanvas[]
        selectedCanvasId?: string
        seriesId?: string
        page?: number
        updatedAt?: string
      },
      savedState: boolean,
    ) => {
      token.current += 1
      setSessionKey(token.current)
      const list = doc.canvases
      // A run folded into a filmstrip is selected through its 画面.
      const wanted = list.find((canvas) => canvas.id === doc.selectedCanvasId)
      const shown = wanted && foldedRunIds(list).has(wanted.id) ? list.find((canvas) => canvas.id === wanted.sourceCanvasId) : wanted
      const selected = shown ?? list.find((canvas) => canvas.kind === 'layout') ?? list[0]
      meta.current = { seriesId: doc.seriesId, page: doc.page }
      knownUpdatedAt.current = doc.updatedAt ?? null
      // Loading is not an edit; a document that still needs writing (an empty
      // project given its first canvas) counts as one.
      savedEdits.current = savedState || !doc.id ? edits.current : edits.current - 1
      // Another project's steps would write into this one.
      history.current = createHistory()
      gesture.current = null
      reshape()
      setProjectId(doc.id)
      setProjectName(doc.name)
      setCanvases(list)
      setSelected(selected?.id ?? null)
      setSaveError(null)
      // A fresh project counts as saved until the user changes something.
      lastSaved.current = savedState || !doc.id ? snapshotOf(doc.name, list, selected?.id ?? null) : ''
    },
    [setCanvases, setProjectId, setProjectName, setSelected, reshape],
  )

  const blankProject = useCallback(
    (names: readonly string[]) => {
      const current = canvasesRef.current.find((canvas) => canvas.id === selectedRef.current)
      const first = createLayoutCanvas([], settingsFrom(current))
      adopt({ id: null, name: nextProjectName(names), canvases: [first], selectedCanvasId: first.id }, true)
    },
    [adopt, canvasesRef, selectedRef],
  )

  const load = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const doc = await client.getProject(id)
        if (!doc) {
          onErrorRef.current('这个项目已经不存在了')
          return false
        }
        const list = Array.isArray(doc.canvases) ? migrateCanvases(doc.canvases) : []
        if (list.length === 0) {
          const first = createLayoutCanvas([], settingsFrom(null))
          adopt({ ...doc, canvases: [first], selectedCanvasId: first.id }, false)
        } else {
          adopt({ ...doc, canvases: list }, true)
        }
        return true
      } catch (error) {
        onErrorRef.current(error instanceof Error ? error.message : String(error))
        return false
      }
    },
    [adopt, client],
  )

  // Open the most recent project on first show, or start a new one.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      const list = await client.listProjects().catch(() => [] as ProjectSummary[])
      setProjects(list)
      if (!(list[0] && (await load(list[0].id)))) blankProject(list.map((item) => item.name))
      setLoaded(true)
    })()
  }, [blankProject, client, load])

  // Autosave a moment after the last change.
  useEffect(() => {
    if (!loaded || snapshot === lastSaved.current) return
    if (!projectId && canvases.length === 0) return
    const timer = setTimeout(() => {
      autosaveTimer.current = null
      void saveNow()
    }, AUTOSAVE_DELAY_MS)
    autosaveTimer.current = timer
    return () => {
      clearTimeout(timer)
      if (autosaveTimer.current === timer) autosaveTimer.current = null
    }
  }, [loaded, snapshot, projectId, canvases.length, saveNow])

  // Leaving the Studio (the shell unmounts it for first-run setup) or closing
  // the window must not drop an edit that is still waiting for the timer. Only
  // edits made here count, and never over a file someone else changed since
  // (another window, the LAN web UI, a test): an older copy must not win.
  const flushRef = useRef<() => void>(() => undefined)
  flushRef.current = () => {
    if (!loadedRef.current || edits.current <= savedEdits.current || !isDirty()) return
    const id = projectIdRef.current
    const queuedIn = token.current
    void (async () => {
      await chain.current
      if (token.current !== queuedIn || edits.current <= savedEdits.current) return
      if (id) {
        const disk = await client.getProject(id).catch(() => undefined)
        if (disk && knownUpdatedAt.current && disk.updatedAt !== knownUpdatedAt.current) return
      }
      await saveNow()
    })()
  }
  useEffect(() => {
    const onUnload = (): void => flushRef.current()
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      flushRef.current()
    }
  }, [])

  // Ctrl/Cmd+S saves now instead of waiting for the timer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!activeRef.current || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      if (isDirty()) void saveNow()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Job progress lands on the canvases that track those jobs; a run called off before it started leaves.
  useEffect(() => {
    if (options.jobs.length) setCanvases((previous) => withoutUnstartedRuns(applyJobs(previous, options.jobs), options.jobs))
  }, [options.jobs, setCanvases])

  /** setCanvases / select for callers: these are local edits. */
  const editCanvases = useCallback(
    (next: CanvasesUpdate, label?: string) => {
      edits.current += 1
      const previous = canvasesRef.current
      setCanvases(next)
      noteRef.current(previous, canvasesRef.current, label)
    },
    [setCanvases, canvasesRef],
  )
  const setRunCanvases = useCallback(
    (next: CanvasesUpdate) => {
      edits.current += 1
      setCanvases(next)
    },
    [setCanvases],
  )
  const select = useCallback(
    (id: string | null) => {
      edits.current += 1
      setSelected(id)
    },
    [setSelected],
  )

  const updateCanvas = useCallback(
    (id: string, patch: Partial<ProjectCanvas> | ((canvas: ProjectCanvas) => ProjectCanvas), label?: string) => {
      editCanvases(
        (previous) =>
          previous.map((canvas) => {
            if (canvas.id !== id) return canvas
            return typeof patch === 'function' ? patch(canvas) : { ...canvas, ...patch }
          }),
        label,
      )
    },
    [editCanvases],
  )

  const addCanvas = useCallback(
    (source?: ProjectCanvas) => {
      const list = canvasesRef.current
      const selectedCanvas = list.find((canvas) => canvas.id === selectedRef.current)
      // A picture card or a 风格 has no generation settings; carry over the latest canvas's instead.
      const generates = (canvas: ProjectCanvas | undefined): boolean => canvas?.kind === 'layout' || canvas?.kind === 'result'
      const current = generates(selectedCanvas) ? selectedCanvas : [...list].reverse().find(generates)
      const canvas = source ? copyAsLayout(source, list) : createLayoutCanvas(list, settingsFrom(current))
      editCanvases([...list, canvas])
      select(canvas.id)
      return canvas
    },
    [canvasesRef, selectedRef, editCanvases, select],
  )

  const removeCanvas = useCallback(
    (id: string) => {
      const { canvases: remaining, removedLinks } = removeCanvasFrom(canvasesRef.current, id)
      editCanvases(remaining)
      if (selectedRef.current === id) {
        select((remaining.find((canvas) => canvas.kind === 'layout') ?? remaining[0])?.id ?? null)
      }
      return removedLinks
    },
    [canvasesRef, selectedRef, editCanvases, select],
  )

  /**
   * After an undo or redo, the card the step was made on is selected (one it
   * brought back first), so the panel shows what changed.
   */
  const selectAfter = useCallback(
    (preferred: string | null, restored: readonly string[]) => {
      const list = canvasesRef.current
      const has = (id: string | null): id is string => id !== null && list.some((canvas) => canvas.id === id)
      const back =
        preferred && restored.includes(preferred)
          ? preferred
          : restored.find((id) => list.find((canvas) => canvas.id === id)?.kind !== 'result')
      const target = back ?? (has(preferred) ? preferred : null)
      if (target) {
        if (target !== selectedRef.current) select(target)
      } else if (!has(selectedRef.current)) {
        select((list.find((canvas) => canvas.kind === 'layout') ?? list[0])?.id ?? null)
      }
    },
    [canvasesRef, selectedRef, select],
  )

  /** Apply the step on top of one stack, when `accept` takes it. Empty steps on top are dropped first. */
  const step = useCallback(
    (direction: 'undo' | 'redo', accept: (taken: HistoryStep) => boolean = () => true): StepOutcome => {
      flushGestureRef.current()
      const steps = history.current
      const from = direction === 'undo' ? steps.undo : steps.redo
      const to = direction === 'undo' ? steps.redo : steps.undo
      while (from.length && isEmptyStep(from.at(-1)!)) from.pop()
      const taken = from.at(-1)
      if (!taken || !accept(taken)) {
        reshape()
        return null
      }
      // Like deleting it by hand: a card whose run is waiting or going is not taken off the board.
      if (removesRunning(canvasesRef.current, taken, direction, jobsRef.current)) return 'running'
      from.pop()
      if (direction === 'undo') taken.selectedAfter = selectedRef.current
      const { canvases: next, restored } = applyStep(canvasesRef.current, taken, direction)
      edits.current += 1
      // A card brought back may have a job that moved on while it was gone.
      setCanvases(applyJobs(next, jobsRef.current))
      to.push(taken)
      steps.sealed = true
      selectAfter(direction === 'undo' ? taken.selectedBefore : taken.selectedAfter, restored)
      reshape()
      return { label: stepLabel(taken), id: taken.id }
    },
    [canvasesRef, selectedRef, setCanvases, selectAfter, reshape],
  )
  const undo = useCallback((only?: number) => step('undo', (taken) => only === undefined || taken.id === only), [step])
  const redo = useCallback((only?: number) => step('redo', (taken) => only === undefined || taken.id === only), [step])
  const top = useCallback((direction: 'undo' | 'redo') => {
    flushGestureRef.current()
    const { undo: back, redo: forward } = history.current
    return liveSteps(direction === 'undo' ? back : forward).at(-1)?.id ?? null
  }, [])
  const within = useCallback(<T>(next: StepGroup, run: () => T): T => {
    const outer = group.current
    group.current = next
    try {
      return run()
    } finally {
      group.current = outer
    }
  }, [])
  const join = useCallback(<T>(id: number | null, run: () => T): T => {
    const latest = history.current.undo.at(-1)
    if (id === null || !latest || latest.id !== id || history.current.sealed) return run()
    const outer = joining.current
    joining.current = latest.token
    try {
      return run()
    } finally {
      joining.current = outer
    }
  }, [])
  const turn = useCallback((calls: readonly string[]) => turnState(history.current, calls), [])
  const turnStep = useCallback(
    (calls: readonly string[], direction: 'undo' | 'redo'): StepOutcome => {
      if (turnState(history.current, calls) !== (direction === 'undo' ? 'latest' : 'redo')) return null
      // Only the turn's own steps: once the next one on top is not the turn's, stop.
      let outcome: StepOutcome = null
      for (;;) {
        const done = step(direction, (taken) => isTurnStep(taken, calls))
        if (done === 'running') return outcome ?? 'running'
        if (!done) return outcome
        outcome = done
      }
    },
    [step],
  )
  const undoTurn = useCallback((calls: readonly string[]) => turnStep(calls, 'undo'), [turnStep])
  const redoTurn = useCallback((calls: readonly string[]) => turnStep(calls, 'redo'), [turnStep])

  /**
   * Before leaving the open project, write its pending edits. False when that
   * save failed: the switch is abandoned so the edits stay on screen.
   */
  const saveBeforeLeaving = useCallback(async (): Promise<boolean> => {
    if (!isDirty()) return true
    if (await saveNow()) return true
    onErrorRef.current('当前项目的改动还没保存，已留在这个项目；请稍后再试')
    return false
  }, [saveNow])

  const openProject = useCallback(
    async (id: string) => {
      if (id === projectIdRef.current) return
      if (!(await saveBeforeLeaving())) return
      await load(id)
    },
    [load, saveBeforeLeaving],
  )

  const newProject = useCallback(async () => {
    if (!(await saveBeforeLeaving())) return
    const list = await client.listProjects().catch(() => projects)
    setProjects(list)
    blankProject(list.map((item) => item.name))
  }, [blankProject, client, projects, saveBeforeLeaving])

  const createProject = useCallback(
    async (name: string): Promise<string | null> => {
      const trimmed = name.trim()
      if (!trimmed) return null
      try {
        const saved = await client.saveProject({ name: trimmed.slice(0, 200), canvases: [] })
        setProjects(await client.listProjects().catch(() => projects))
        return saved.id
      } catch (error) {
        onErrorRef.current(error instanceof Error ? error.message : String(error))
        return null
      }
    },
    [client, projects],
  )

  const rename = useCallback(
    (name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return
      edits.current += 1
      setProjectName(trimmed)
    },
    [setProjectName],
  )

  const deleteProject = useCallback(
    async (id: string) => {
      const isOpen = id === projectIdRef.current
      const previousSaved = lastSaved.current
      const previousSavedEdits = savedEdits.current
      if (isOpen) {
        // Before anything is awaited: no pending or queued save may write the
        // deleted project back (main would recreate it under a new id).
        token.current += 1
        if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
        autosaveTimer.current = null
        lastSaved.current = liveSnapshot()
        savedEdits.current = edits.current
        // A save already on its way finishes before the delete, so the delete wins.
        await chain.current
      }
      try {
        await client.deleteProject(id)
      } catch (error) {
        onErrorRef.current(error instanceof Error ? error.message : String(error))
        if (isOpen) {
          // The project is still open: put back what was pending.
          lastSaved.current = previousSaved
          savedEdits.current = previousSavedEdits
          if (isDirty()) void saveNow()
        }
        return
      }
      const list = await client.listProjects().catch(() => projects.filter((item) => item.id !== id))
      setProjects(list)
      if (!isOpen) return
      if (!(list[0] && (await load(list[0].id)))) blankProject(list.map((item) => item.name))
    },
    [blankProject, client, load, projects, saveNow],
  )

  const selectedCanvas = canvases.find((canvas) => canvas.id === selectedCanvasId) ?? null
  const dirty = snapshot !== lastSaved.current && (projectId !== null || canvases.length > 0)
  const saveStatus: SaveStatus = saveError ? 'error' : saving > 0 || dirty ? 'saving' : projectId ? 'saved' : 'idle'

  return {
    loaded,
    sessionKey,
    projects,
    projectId,
    projectName,
    canvases,
    canvasesRef,
    selectedCanvasId,
    selectedRef,
    selectedCanvas,
    saveStatus,
    saveError,
    setCanvases: editCanvases,
    setRunCanvases,
    updateCanvas,
    select,
    addCanvas,
    removeCanvas,
    saveNow,
    openProject,
    newProject,
    createProject,
    rename,
    deleteProject,
    history: { ...historyShape, undo, redo, top, within, join, turn, undoTurn, redoTurn },
  }
}
