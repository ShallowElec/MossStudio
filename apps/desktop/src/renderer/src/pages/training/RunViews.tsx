import { ChevronLeft, FolderOpen, ImageOff, Square, Trash2, Wand2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Ipc } from '@shared/channels'
import type { TrainingProject, TrainingSamples } from '@shared/training'
import { call } from '../../lib/api'
import { duration, thousands } from '../../lib/format'
import { useShell } from '../../lib/shell'
import { useApp } from '../../store'
import { Notice } from '../../components/common/Notice'
import { Button, ConfirmDialog, EmptyState, FieldLabel, LoadingRow, Pill, ProgressBar, Spinner, useToast } from '../../components/ui'
import { recipeLine } from './editorModel'
import { curvePath, lossCurve, runPill, runProgress } from './runModel'
import { SampleGrid } from './SampleGrid'
import { newestDrawnStep, sampleColumns, stepName } from './sampleGridModel'
import { KIND_LABEL, savedLora } from './trainingModel'
import { errorText } from './useTraining'

/** How often a running training's sample pictures are read again while it is on screen. */
const SAMPLES_POLL_MS = 15_000

/** True while the element is laid out (the page is not hidden) and the window is visible. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [shown, setShown] = useState(true)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const update = (): void => setShown(element.getClientRects().length > 0 && document.visibilityState === 'visible')
    const observer = new ResizeObserver(update)
    observer.observe(element)
    document.addEventListener('visibilitychange', update)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', update)
    }
  }, [ref])
  return shown
}

function useSamples(id: string, refreshKey: unknown): { samples: TrainingSamples | null | undefined; reload: () => Promise<void> } {
  const [samples, setSamples] = useState<TrainingSamples | null | undefined>(undefined)
  const reload = useCallback(async () => {
    try {
      setSamples(await call<TrainingSamples>(Ipc.trainingSamples, { id }))
    } catch {
      // No samples to show yet (or the run folder is gone): the grid says so.
      setSamples((previous) => previous ?? null)
    }
  }, [id])
  useEffect(() => {
    void reload()
  }, [reload, refreshKey])
  return { samples, reload }
}

function Facts({ project, place, extra }: { project: TrainingProject; place?: string; extra?: [string, string] }): React.JSX.Element {
  const rows: Array<[string, string]> = [
    ['学什么', KIND_LABEL[project.kind]],
    ...(project.trigger ? [['触发词', project.trigger] as [string, string]] : []),
    ['图片', `${project.imageCount} 张`],
    ['设置', recipeLine(project.recipe)],
    ...(place ? [['位置', place] as [string, string]] : []),
    ...(extra ? [extra] : []),
  ]
  return (
    <dl className="flex flex-col" data-training-facts>
      {rows.map(([term, value]) => (
        <div key={term} className="flex justify-between gap-4 text-ui leading-[22px]">
          <dt className="shrink-0 text-ink-2">{term}</dt>
          <dd className="min-w-0 truncate text-right text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function PanelHead({ project, pill, onBack }: { project: TrainingProject; pill: React.ReactNode; onBack: () => void }): React.JSX.Element {
  return (
    <>
      <div>
        <Button tone="ghost" size="xs" className="-ml-2" onClick={onBack}>
          <ChevronLeft className="size-3.5" strokeWidth={1.6} aria-hidden="true" />
          全部训练
        </Button>
      </div>
      <div className="flex items-center justify-between gap-3">
        <h1 className="min-w-0 truncate text-title font-semibold text-ink">{project.name}</h1>
        {pill}
      </div>
    </>
  )
}

function Panel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <aside aria-label="训练" className="flex w-[320px] shrink-0 flex-col gap-5 overflow-y-auto bg-panel px-5 pb-5 pt-3">
      {children}
    </aside>
  )
}

function LossCurve({ points }: { points: Array<{ step: number; loss: number }> }): React.JSX.Element | null {
  const path = curvePath(points, 280, 48)
  if (!path) return null
  return (
    <svg viewBox="0 0 280 48" preserveAspectRatio="none" className="h-12 w-full text-accent" aria-hidden="true">
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** A training while it runs: progress and loss on the left, the sample pictures as they arrive. */
export function RunningView({
  project,
  place,
  onBack,
  onChanged,
}: {
  project: TrainingProject
  place: string
  onBack: () => void
  onChanged: (project: TrainingProject) => void
}): React.JSX.Element {
  const toast = useToast()
  const root = useRef<HTMLDivElement>(null)
  const shown = useOnScreen(root)
  const openActivity = useShell((state) => state.openActivity)
  const job = useApp((state) => state.jobs.find((item) => item.id === project.jobId))
  const progress = runProgress(project, job)
  const points = lossCurve(job)
  const [stopping, setStopping] = useState(false)
  // A new sample column is due each time the run passes a multiple of sampleEvery.
  const sampleTick = project.recipe.sampleEvery > 0 ? Math.floor(progress.step / project.recipe.sampleEvery) : 0
  const { samples, reload } = useSamples(project.id, `${sampleTick}:${project.updatedAt}`)

  useEffect(() => {
    if (!shown) return
    const timer = window.setInterval(() => void reload(), SAMPLES_POLL_MS)
    return () => window.clearInterval(timer)
  }, [shown, reload])

  const columns = useMemo(
    () =>
      samples
        ? sampleColumns({
            samples,
            chosenStep: null,
            sampleEvery: project.recipe.sampleEvery,
            totalSteps: progress.total,
            // While starting there is no run to place steps on yet: no empty columns to come.
            running: project.state === 'running' ? { step: progress.step, etaMs: progress.etaMs } : undefined,
          })
        : [],
    [samples, project.state, project.recipe.sampleEvery, progress.total, progress.step, progress.etaMs],
  )
  const [done, left] = progress.text.split(' · 还要')

  async function stop(): Promise<void> {
    setStopping(true)
    try {
      await call(Ipc.trainingStop, { id: project.id })
      onChanged(await call<TrainingProject>(Ipc.trainingGet, { id: project.id }))
    } catch (error) {
      toast.push(`没能停止：${errorText(error)}`, 'error')
    } finally {
      setStopping(false)
    }
  }

  return (
    <div ref={root} className="flex h-full min-h-0" data-training-view="running">
      <Panel>
        <PanelHead project={project} pill={<Pill tone="accent">{runPill(project.state)}</Pill>} onBack={onBack} />
        <div className="flex flex-col gap-2">
          <ProgressBar value={progress.percent} label={`${project.name} 训练进度`} />
          <div className="tabular flex justify-between gap-3 text-caption text-ink-2" data-run-progress>
            <span>{done}</span>
            {left ? <span>还要{left}</span> : null}
          </div>
        </div>
        {progress.loss !== null ? (
          <div className="flex flex-col gap-1.5">
            <FieldLabel value={<span className="text-ink">{progress.loss.toFixed(3)}</span>}>损失</FieldLabel>
            <LossCurve points={points} />
          </div>
        ) : null}
        <Facts project={project} place={place} />
        <div className="flex-1" />
        {/* Until the job exists (starting) there is nothing to stop or read yet. */}
        {project.jobId ? (
          <div className="flex gap-2">
            <Button className="flex-1" disabled={stopping} onClick={() => void stop()}>
              {stopping ? <Spinner /> : <Square className="size-3.5" strokeWidth={1.6} aria-hidden="true" />}
              停止
            </Button>
            <Button tone="ghost" onClick={() => openActivity('jobs', project.jobId)}>
              查看日志
            </Button>
          </div>
        ) : null}
      </Panel>
      {samples === undefined ? (
        <div className="flex-1 bg-board px-7 py-6">
          <LoadingRow />
        </div>
      ) : samples && columns.length && samples.prompts.length ? (
        <SampleGrid prompts={samples.prompts} columns={columns} current={newestDrawnStep(columns)} />
      ) : (
        <div className="flex flex-1 bg-board">
          <EmptyState
            icon={<ImageOff className="size-8" strokeWidth={1.6} />}
            title={project.recipe.sampleEvery > 0 ? '第一组样图画好后会出现在这里' : '这次训练不画样图'}
            className="flex-1"
          />
        </div>
      )}
    </div>
  )
}

const RESULT_PILL = {
  done: { tone: 'ok', text: '完成' },
  stopped: { tone: 'neutral', text: '已停止' },
  failed: { tone: 'danger', text: '失败' },
} as const

/**
 * A finished, stopped or failed training: the samples to choose a step from
 * by looking, what was saved, and what to do next.
 */
export function ResultView({
  project,
  place,
  onBack,
  onChanged,
  onRemoved,
  onOpen,
}: {
  project: TrainingProject
  place: string
  onBack: () => void
  onChanged: (project: TrainingProject) => void
  onRemoved: (id: string) => void
  onOpen: (project: TrainingProject) => void
}): React.JSX.Element {
  const toast = useToast()
  const navigate = useNavigate()
  const openActivity = useShell((state) => state.openActivity)
  const requestStudioTry = useApp((state) => state.requestStudioTry)
  const refreshCatalog = useApp((state) => state.refreshCatalog)
  const { samples } = useSamples(project.id, project.updatedAt)
  const [choosing, setChoosing] = useState<number | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [working, setWorking] = useState(false)
  const pill =
    RESULT_PILL[project.state === 'done' || project.state === 'stopped' || project.state === 'failed' ? project.state : 'stopped']
  const columns = useMemo(
    () =>
      samples
        ? sampleColumns({
            samples,
            chosenStep: project.chosenStep,
            sampleEvery: project.recipe.sampleEvery,
            totalSteps: project.recipe.steps,
          })
        : [],
    [samples, project.chosenStep, project.recipe.sampleEvery, project.recipe.steps],
  )
  const { saved, retryStep } = savedLora(project)
  const canChoose = columns.some((column) => column.choosable)

  async function choose(step: number): Promise<void> {
    setChoosing(step)
    try {
      onChanged(await call<TrainingProject>(Ipc.trainingChooseStep, { id: project.id, step }))
    } catch (error) {
      toast.push(`没能保存这一步：${errorText(error)}`, 'error')
    } finally {
      setChoosing(null)
    }
  }

  async function tryInStudio(): Promise<void> {
    if (!project.adapterId) return
    await refreshCatalog().catch(() => undefined)
    requestStudioTry({
      id: crypto.randomUUID(),
      adapterId: project.adapterId,
      name: project.name,
      prompt: project.recipe.samplePrompts[0] ?? samples?.prompts[0] ?? project.trigger,
    })
    void navigate('/studio')
  }

  async function again(): Promise<void> {
    setWorking(true)
    try {
      onOpen(await call<TrainingProject>(Ipc.trainingDuplicate, { id: project.id }))
    } catch (error) {
      toast.push(`没能新建：${errorText(error)}`, 'error')
    } finally {
      setWorking(false)
    }
  }

  async function remove(): Promise<void> {
    setConfirming(false)
    try {
      await call(Ipc.trainingRemove, { id: project.id })
      onRemoved(project.id)
    } catch (error) {
      toast.push(`没能删除：${errorText(error)}`, 'error')
    }
  }

  const took = duration(project.startedAt ?? undefined, project.finishedAt ?? undefined)

  return (
    <div className="flex h-full min-h-0" data-training-view="result">
      <Panel>
        <PanelHead project={project} pill={<Pill tone={pill.tone}>{pill.text}</Pill>} onBack={onBack} />
        {project.state === 'failed' ? (
          <Notice
            tone="danger"
            action={
              project.jobId ? (
                <Button size="xs" onClick={() => openActivity('jobs', project.jobId)}>
                  查看日志
                </Button>
              ) : undefined
            }
          >
            {project.failure ?? '训练没有完成。'}
          </Notice>
        ) : null}
        {project.chosenStep !== null ? (
          <div className="flex flex-col gap-1" data-chosen-step={project.chosenStep}>
            <p className="text-control text-ink">
              用 <b className="font-semibold">{stepName(project.chosenStep)}</b> 的结果
            </p>
            {saved ? <p className="text-caption text-ink-2">已保存到 模型 › LoRA</p> : null}
          </div>
        ) : canChoose && !project.saveError ? (
          <p className="text-control text-ink">点一列样图，保存那一步的结果</p>
        ) : null}
        {project.saveError ? (
          <Notice
            tone="danger"
            data-save-error={project.saveErrorStep ?? ''}
            title={project.saveErrorStep !== null ? `${stepName(project.saveErrorStep)} 没有保存` : undefined}
            action={
              retryStep !== null ? (
                <Button size="xs" disabled={choosing !== null} onClick={() => void choose(retryStep)}>
                  {choosing === retryStep ? <Spinner /> : null}
                  重试
                </Button>
              ) : undefined
            }
          >
            {project.saveError}
          </Notice>
        ) : null}
        {saved ? (
          <Button tone="primary" size="lg" block onClick={() => void tryInStudio()}>
            <Wand2 className="size-4" strokeWidth={1.6} aria-hidden="true" />
            在创作中试用
          </Button>
        ) : null}
        <div className="flex gap-2">
          <Button tone={saved ? 'secondary' : 'primary'} className="flex-1" disabled={working} onClick={() => void again()}>
            {working ? <Spinner /> : null}
            再训练一次
          </Button>
          <Button
            tone="ghost"
            onClick={() =>
              void call(Ipc.trainingReveal, { id: project.id }).catch((error: unknown) => toast.push(errorText(error), 'error'))
            }
          >
            <FolderOpen className="size-4" strokeWidth={1.6} aria-hidden="true" />
            在文件夹中显示
          </Button>
        </div>
        <Facts
          project={project}
          place={project.state === 'done' ? undefined : place}
          extra={
            project.state === 'done' && took
              ? ['用时', took]
              : project.stepReached
                ? ['停在', `第 ${thousands(project.stepReached)} 步`]
                : undefined
          }
        />
        <div className="flex-1" />
        <div>
          <Button tone="ghost-danger" className="-ml-2" onClick={() => setConfirming(true)}>
            <Trash2 className="size-4" strokeWidth={1.6} aria-hidden="true" />
            删除
          </Button>
        </div>
      </Panel>
      {samples === undefined ? (
        <div className="flex-1 bg-board px-7 py-6">
          <LoadingRow />
        </div>
      ) : samples && columns.length && samples.prompts.length ? (
        <SampleGrid
          prompts={samples.prompts}
          columns={columns}
          busyStep={choosing}
          onChoose={(step) => {
            if (step !== project.chosenStep || project.saveError) void choose(step)
          }}
        />
      ) : (
        <div className="flex flex-1 bg-board">
          <EmptyState icon={<ImageOff className="size-8" strokeWidth={1.6} />} title="这次训练没有样图" className="flex-1" />
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title={`删除「${project.name}」？`}
        description="训练记录和图片会删除；已保存的 LoRA 留在 模型 里。"
        confirmLabel="删除"
        onClose={() => setConfirming(false)}
        onConfirm={() => void remove()}
      />
    </div>
  )
}
