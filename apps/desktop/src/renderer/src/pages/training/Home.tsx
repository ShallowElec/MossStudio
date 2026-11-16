import { ChevronLeft, ImageOff, Package, Palette, Plus, UserRound, type LucideIcon } from 'lucide-react'
import { useMemo } from 'react'
import { TRAINING_KINDS, type TrainingKind, type TrainingProject } from '@shared/training'
import type { JobRecord } from '@shared/types'
import { cloverUrl } from '../../lib/clover'
import { relative } from '../../lib/format'
import { useApp } from '../../store'
import { Button, PageHeader, Pill, ProgressBar, Spinner, Tag, cn } from '../../components/ui'
import { KIND_LABEL, KIND_TILE_LABEL, homeCard, splitHome } from './trainingModel'
import { runProgress } from './runModel'

const KIND_ICON: Record<TrainingKind, LucideIcon> = { person: UserRound, style: Palette, object: Package }

/** 想教模型什么？: three big choices; each starts a new training of that kind. */
export function StartTiles({
  creating,
  onPick,
  onBack,
}: {
  creating: TrainingKind | null
  onPick: (kind: TrainingKind) => void
  onBack?: () => void
}): React.JSX.Element {
  return (
    <div className="relative flex h-full flex-col items-center gap-8 overflow-y-auto bg-board px-6 pb-16 pt-28">
      {onBack ? (
        <Button tone="ghost" className="absolute left-6 top-6" onClick={onBack}>
          <ChevronLeft className="size-4" strokeWidth={1.6} aria-hidden="true" />
          全部训练
        </Button>
      ) : null}
      <h1 className="text-display font-semibold text-ink">想教模型什么？</h1>
      <div className="flex flex-wrap justify-center gap-5">
        {TRAINING_KINDS.map((kind) => {
          const Icon = KIND_ICON[kind]
          return (
            <button
              key={kind}
              type="button"
              data-start-kind={kind}
              disabled={creating !== null}
              onClick={() => onPick(kind)}
              className="flex w-[260px] flex-col gap-3 rounded-xl bg-surface p-3 text-left transition-colors enabled:hover:bg-raised disabled:opacity-60"
            >
              <span className="flex h-[184px] items-center justify-center rounded-lg bg-well text-ink-2">
                {creating === kind ? <Spinner className="size-6" /> : <Icon className="size-12" strokeWidth={1.2} aria-hidden="true" />}
              </span>
              <span className="px-1 pb-1 text-section font-semibold text-ink">{KIND_TILE_LABEL[kind]}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Cover({ path, faded, className }: { path: string | null; faded?: boolean; className?: string }): React.JSX.Element {
  return path ? (
    <img
      src={cloverUrl(path)}
      alt=""
      draggable={false}
      className={cn('aspect-square w-full rounded-md bg-[var(--image-placeholder)] object-cover', faded && 'opacity-60', className)}
    />
  ) : (
    <span className={cn('flex aspect-square w-full items-center justify-center rounded-md bg-well text-ink-2', className)}>
      <ImageOff className="size-6" strokeWidth={1.6} aria-hidden="true" />
    </span>
  )
}

function RunningCard({
  training,
  job,
  onOpen,
}: {
  training: TrainingProject
  job: JobRecord | undefined
  onOpen: () => void
}): React.JSX.Element {
  const progress = runProgress(training, job)
  return (
    <div className="flex items-center gap-4 rounded-xl bg-surface p-3" data-training-card={training.id}>
      <div className="w-[72px] shrink-0">
        <Cover path={training.cover} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="truncate text-control font-semibold text-ink">{training.name}</span>
          <Tag>{KIND_LABEL[training.kind]}</Tag>
        </div>
        <ProgressBar value={progress.percent} className="max-w-[420px]" label={`${training.name} 训练进度`} />
        <span className="tabular text-caption text-ink-2">{progress.text}</span>
      </div>
      <Pill tone="accent">训练中</Pill>
      <Button onClick={onOpen}>查看</Button>
    </div>
  )
}

/** The trainings: a wide card for each running one, then a grid of the rest. */
export function HomeList({
  trainings,
  onOpen,
  onNew,
}: {
  trainings: TrainingProject[]
  onOpen: (id: string) => void
  onNew: () => void
}): React.JSX.Element {
  const jobs = useApp((state) => state.jobs)
  const { running, rest } = useMemo(() => splitHome(trainings), [trainings])
  return (
    <div className="h-full overflow-y-auto bg-board">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-8 pb-16 pt-8">
        <PageHeader
          title="训练"
          actions={
            <Button tone="primary" onClick={onNew}>
              <Plus className="size-4" strokeWidth={1.6} aria-hidden="true" />
              新建训练
            </Button>
          }
        />
        {running.map((training) => (
          <RunningCard
            key={training.id}
            training={training}
            job={jobs.find((job) => job.id === training.jobId)}
            onOpen={() => onOpen(training.id)}
          />
        ))}
        {rest.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4">
            {rest.map((training) => {
              const card = homeCard(training, relative)
              return (
                <button
                  key={training.id}
                  type="button"
                  data-training-card={training.id}
                  onClick={() => onOpen(training.id)}
                  className="flex min-w-0 flex-col gap-2 rounded-xl bg-surface p-2 text-left transition-colors hover:bg-raised"
                >
                  <Cover path={card.cover} faded={training.state === 'stopped'} />
                  <span className="flex items-center gap-1.5 px-1">
                    <span className="min-w-0 flex-1 truncate text-control text-ink">{card.name}</span>
                    {card.pill ? <Pill tone={card.pill.tone}>{card.pill.text}</Pill> : <Tag>{card.kind}</Tag>}
                  </span>
                  <span className="truncate px-1 pb-1 text-caption text-ink-2" title={card.caption}>
                    {card.caption}
                  </span>
                </button>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}
