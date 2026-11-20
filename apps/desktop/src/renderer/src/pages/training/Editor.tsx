import { ChevronLeft, Play } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Ipc } from '@shared/channels'
import type { AiProviderInfo } from '@shared/ai'
import {
  TRAINING_KINDS,
  TRAINING_LENGTHS,
  trainingSchemas,
  type DatasetImage,
  type TrainingCaptionResult,
  type TrainingDataset,
  type TrainingKind,
  type TrainingProject,
  type TrainingReadiness,
} from '@shared/training'
import type { ManagedHost } from '@shared/types'
import { call } from '../../lib/api'
import { Notice } from '../../components/common/Notice'
import { Advanced, Button, FieldLabel, Input, Segmented, Spinner, useToast } from '../../components/ui'
import { ProviderDialog, useModelGate } from '../../components/common/ProviderDialog'
import { sectionPath } from '../settings/sections'
import {
  LENGTH_LABEL,
  advancedSummary,
  lengthLabel,
  withImage,
  withKind,
  withLength,
  withRecipe,
  withTrigger,
  type DraftPatch,
} from './editorModel'
import { Pictures } from './Pictures'
import { RecipeFields } from './RecipeFields'
import { KIND_LABEL } from './trainingModel'
import { errorText, readPreference, writePreference } from './useTraining'

const ADVANCED_KEY = 'mossstudio.training.advancedOpen'
const AUTOSAVE_MS = 500

const patchSchema = trainingSchemas.update.shape.patch

/** Only the fields of a patch that would be accepted; the rest wait until they are fixed. */
function acceptable(patch: DraftPatch): DraftPatch {
  return Object.fromEntries(Object.entries(patch).filter(([key, value]) => patchSchema.safeParse({ [key]: value }).success)) as DraftPatch
}

/** Paths of files dropped from the file manager (Electron gives each File its path). */
function droppedPaths(event: React.DragEvent): string[] {
  return [...event.dataTransfer.files].map((file) => window.clover.pathForFile?.(file) ?? '').filter(Boolean)
}

/**
 * A draft: 学什么, 名字, 触发词 and 训练多久 on the left with 高级 below, the
 * pictures as the main area. Every change saves itself; 开始训练 saves first.
 */
export function Editor({
  initial,
  readiness,
  place,
  sshHosts,
  onSaved,
  onBack,
  startProblem,
  onStartProblem,
}: {
  initial: TrainingProject
  readiness: TrainingReadiness | null | undefined
  place: string
  sshHosts: ManagedHost[]
  onSaved: (project: TrainingProject) => void
  onBack: () => void
  /** Why the last 开始训练 failed. It is kept by the page: while starting, this editor is not on screen. */
  startProblem: string | null
  onStartProblem: (problem: string | null) => void
}): React.JSX.Element {
  const toast = useToast()
  const [project, setProject] = useState(initial)
  const [dataset, setDataset] = useState<TrainingDataset | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(() => readPreference(ADVANCED_KEY) === '1')
  const [captioning, setCaptioning] = useState(false)
  const [captionError, setCaptionError] = useState<string | null>(null)
  const [noPictures, setNoPictures] = useState(false)
  const navigate = useNavigate()
  const [providers, setProviders] = useState<AiProviderInfo[] | null>(null)
  const [connecting, setConnecting] = useState(false)
  const gate = useModelGate()
  const [starting, setStarting] = useState(false)
  const [problem, setProblem] = useState<string | null>(startProblem)
  const [dragging, setDragging] = useState(false)
  const pending = useRef<DraftPatch>({})
  const timer = useRef<number | null>(null)
  const latest = useRef(project)
  latest.current = project

  /** Save what is waiting; false when the save failed (the changes stay waiting for the next try). */
  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    const patch = acceptable(pending.current)
    pending.current = {}
    if (!Object.keys(patch).length) return true
    try {
      const saved = await call<TrainingProject>(Ipc.trainingUpdate, { id: initial.id, patch })
      onSaved(saved)
      return true
    } catch (error) {
      // Edits made meanwhile are newer than the ones that failed.
      pending.current = { ...patch, ...pending.current }
      toast.push(`没有保存：${errorText(error)}`, 'error')
      return false
    }
  }, [initial.id, onSaved, toast])

  // Leaving the editor saves what is still waiting.
  useEffect(() => () => void flush(), [flush])

  const change = (patch: DraftPatch): void => {
    if (!Object.keys(patch).length) return
    setProject((previous) => ({ ...previous, ...patch }))
    pending.current = { ...pending.current, ...patch }
    setProblem(null)
    onStartProblem(null)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void flush(), AUTOSAVE_MS)
  }

  const loadDataset = useCallback(async () => {
    try {
      setDataset(await call<TrainingDataset>(Ipc.trainingDataset, { id: initial.id }))
    } catch (error) {
      toast.push(`没能读取图片：${errorText(error)}`, 'error')
      setDataset({ images: [], counts: { total: 0, small: 0, duplicate: 0, noCaption: 0 } })
    }
  }, [initial.id, toast])

  useEffect(() => {
    void loadDataset()
  }, [loadDataset])

  async function addPaths(paths: string[]): Promise<void> {
    if (!paths.length) return
    try {
      setDataset(await call<TrainingDataset>(Ipc.trainingDatasetAdd, { id: initial.id, paths }))
      setProblem(null)
    } catch (error) {
      toast.push(`没能添加图片：${errorText(error)}`, 'error')
    }
  }

  async function addFiles(): Promise<void> {
    const paths = await call<string[]>(Ipc.pickImages, { title: '选择训练图片' }).catch(() => [])
    await addPaths(paths)
  }

  async function addFolder(): Promise<void> {
    const path = await call<string | null>(Ipc.pickDialog, { kind: 'folder', title: '选择放图片的文件夹' }).catch(() => null)
    if (path) await addPaths([path])
  }

  async function remove(name: string): Promise<void> {
    try {
      setDataset(await call<TrainingDataset>(Ipc.trainingDatasetRemove, { id: initial.id, names: [name] }))
    } catch (error) {
      toast.push(`没能移除：${errorText(error)}`, 'error')
    }
  }

  async function setCaption(name: string, caption: string): Promise<void> {
    try {
      const image = await call<DatasetImage>(Ipc.trainingCaptionSet, { id: initial.id, name, caption })
      setDataset((previous) => (previous ? withImage(previous, image) : previous))
    } catch (error) {
      toast.push(`描述没有保存：${errorText(error)}`, 'error')
    }
  }

  async function autoCaption(): Promise<void> {
    setCaptioning(true)
    setCaptionError(null)
    setNoPictures(false)
    try {
      const result = await call<TrainingCaptionResult>(Ipc.trainingCaptionAuto, { id: initial.id })
      if (result.error) {
        setCaptionError(result.error)
        setNoPictures(Boolean(result.noPictures))
        setProviders(await call<AiProviderInfo[]>(Ipc.aiProvidersList).catch(() => []))
      } else {
        toast.push(
          result.failed ? `写好了 ${result.written} 张，${result.failed} 张没有写成` : `写好了 ${result.written} 张图片的描述`,
          'success',
        )
      }
      await loadDataset()
    } catch (error) {
      setCaptionError(errorText(error))
    } finally {
      setCaptioning(false)
    }
  }

  /**
   * The start shows as `starting` (an event) long before this call answers, so the run
   * view replaces the editor meanwhile; a failure brings the draft back, and the page
   * hands the reason to the editor that shows it then.
   */
  async function start(): Promise<void> {
    setStarting(true)
    setProblem(null)
    onStartProblem(null)
    try {
      // The run uses the settings on disk, so it never starts with ones that did not save.
      if (!(await flush())) {
        setProblem('设置没有保存，所以没有开始训练。请再试一次。')
        return
      }
      const started = await call<TrainingProject>(Ipc.trainingStart, { id: initial.id })
      onSaved(started)
    } catch (error) {
      setProblem(errorText(error))
      onStartProblem(errorText(error))
    } finally {
      setStarting(false)
    }
  }

  const triggerProblem = project.kind !== 'style' && !/^[A-Za-z0-9_]*$/.test(project.trigger.trim()) ? '触发词只能用字母、数字和 _' : null
  const nameProblem = project.name.trim() ? null : '给这个训练起个名字'

  return (
    <div
      className="relative flex h-full min-h-0"
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes('Files')) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        void addPaths(droppedPaths(event))
      }}
    >
      <aside
        className={`flex shrink-0 flex-col gap-5 overflow-y-auto bg-panel px-5 pb-5 pt-3 ${advancedOpen ? 'w-[340px]' : 'w-[320px]'}`}
        aria-label="训练设置"
      >
        <div>
          <Button tone="ghost" size="xs" className="-ml-2" onClick={onBack}>
            <ChevronLeft className="size-3.5" strokeWidth={1.6} aria-hidden="true" />
            全部训练
          </Button>
        </div>
        <div className="flex flex-col gap-1.5">
          <FieldLabel>学什么</FieldLabel>
          <Segmented<TrainingKind>
            block
            label="学什么"
            value={project.kind}
            onChange={(kind) => change(withKind(latest.current, kind))}
            options={TRAINING_KINDS.map((kind) => ({ value: kind, label: KIND_LABEL[kind] }))}
          />
        </div>
        <div className={advancedOpen ? 'grid grid-cols-2 gap-2.5' : 'flex flex-col gap-5'}>
          <div className="flex min-w-0 flex-col gap-1.5">
            <FieldLabel htmlFor="training-name">名字</FieldLabel>
            <Input
              id="training-name"
              value={project.name}
              maxLength={60}
              aria-invalid={nameProblem ? true : undefined}
              onChange={(event) => change({ name: event.target.value })}
            />
            {nameProblem ? (
              <span role="alert" className="text-caption text-danger">
                {nameProblem}
              </span>
            ) : null}
          </div>
          {project.kind === 'style' ? null : (
            <div className="flex min-w-0 flex-col gap-1.5">
              <FieldLabel htmlFor="training-trigger">触发词</FieldLabel>
              <Input
                id="training-trigger"
                value={project.trigger}
                maxLength={32}
                spellCheck={false}
                aria-invalid={triggerProblem ? true : undefined}
                onChange={(event) => change(withTrigger(latest.current, event.target.value))}
                className="font-mono"
              />
              {triggerProblem ? (
                <span role="alert" className="text-caption text-danger">
                  {triggerProblem}
                </span>
              ) : null}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <FieldLabel value={<span data-length-label>{lengthLabel(project)}</span>}>训练多久</FieldLabel>
          <Segmented<TrainingProject['length']>
            block
            label="训练多久"
            value={project.length}
            onChange={(length) => {
              if (length !== 'custom') change(withLength(latest.current, length))
            }}
            options={TRAINING_LENGTHS.map((length) => ({ value: length, label: LENGTH_LABEL[length] }))}
          />
        </div>
        <Advanced
          dense
          className="-mx-3.5"
          open={advancedOpen}
          onOpenChange={(open) => {
            setAdvancedOpen(open)
            writePreference(ADVANCED_KEY, open ? '1' : '0')
          }}
          summary={advancedSummary(project, place)}
        >
          <div className="px-3.5">
            <RecipeFields
              project={project}
              baseModel={readiness?.baseModel.name ?? 'MOSS-Image Base'}
              sshHosts={sshHosts}
              onRecipe={(patch) => change(withRecipe(latest.current, patch))}
              onHost={(hostId) => change({ hostId })}
            />
          </div>
        </Advanced>
        <div className="flex-1" />
        {problem ? (
          <Notice tone="danger" data-start-problem>
            {problem}
          </Notice>
        ) : null}
        <Button tone="primary" size="lg" block disabled={starting || Boolean(nameProblem || triggerProblem)} onClick={() => void start()}>
          {starting ? <Spinner /> : <Play className="size-4" strokeWidth={1.6} aria-hidden="true" />}
          开始训练
        </Button>
      </aside>
      <Pictures
        trainingId={initial.id}
        dataset={dataset}
        captioning={captioning}
        notice={
          captionError ? (
            <Notice
              tone="warn"
              data-caption-problem
              action={
                // A model that takes no pictures is swapped where the models are chosen; else connect one.
                noPictures ? (
                  <Button size="xs" onClick={() => void navigate(sectionPath('llm'))}>
                    换一个模型
                  </Button>
                ) : providers !== null ? (
                  <Button size="xs" onClick={() => setConnecting(true)}>
                    连接语言模型
                  </Button>
                ) : undefined
              }
            >
              {captionError}
            </Notice>
          ) : null
        }
        onAddFiles={() => void addFiles()}
        onAddFolder={() => void addFolder()}
        onRemove={(name) => void remove(name)}
        onCaption={(name, caption) => void setCaption(name, caption)}
        onAutoCaption={() => void gate.require({ action: '自动写描述' }, () => void autoCaption())}
      />
      {dragging ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--scrim)]">
          <span className="rounded-xl bg-raised px-6 py-4 text-control font-semibold text-ink shadow-float">松开即可添加图片</span>
        </div>
      ) : null}
      <ProviderDialog
        open={connecting}
        providers={providers ?? []}
        busy={false}
        onClose={() => setConnecting(false)}
        onChanged={async () => {
          setProviders(await call<AiProviderInfo[]>(Ipc.aiProvidersList).catch(() => []))
          setCaptionError(null)
        }}
      />
      {gate.dialog}
    </div>
  )
}
