import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Events, Ipc } from '@shared/channels'
import type { TrainingKind, TrainingProject, TrainingReadiness } from '@shared/training'
import type { ManagedHost } from '@shared/types'
import { call, onEvent } from '../../lib/api'
import { useApp } from '../../store'
import { Notice } from '../../components/common/Notice'
import { Button, EmptyState, LoadingRow, useToast } from '../../components/ui'
import { Editor } from './Editor'
import { Blocked, FirstUse } from './FirstUse'
import { HomeList, StartTiles } from './Home'
import { ResultView, RunningView } from './RunViews'
import { homeView, projectView } from './trainingModel'
import { errorText, useReadiness, useTrainingHost, useTrainings } from './useTraining'

/** "本机 · RTX 4070", or the remote computer's name. */
function placeOf(hostId: string, sshHosts: readonly ManagedHost[], readiness: TrainingReadiness | null | undefined): string {
  const name = hostId === 'local' ? '本机' : (sshHosts.find((host) => host.id === hostId)?.name ?? '远程电脑')
  const gpu = readiness?.hostId === hostId ? readiness.gpu.name.replace(/^NVIDIA (GeForce )?/, '') : ''
  return gpu ? `${name} · ${gpu}` : name
}

/**
 * 训练: `/training` is the list (or first use, or what to teach), and
 * `/training/:id` one training: the editor while it is a draft, its run, then
 * its result. The page stays mounted while others are shown.
 */
export function TrainingPage(): React.JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const toast = useToast()
  const remoteHostsEnabled = useApp((state) => state.settings?.remoteHostsEnabled ?? false)
  const host = useTrainingHost()
  const { readiness, error, refresh } = useReadiness(host.hostId)
  const { trainings, upsert, drop } = useTrainings()
  const [picking, setPicking] = useState(false)
  const [creating, setCreating] = useState<TrainingKind | null>(null)

  const last = useRef('/training')
  const onTraining = location.pathname === '/training' || location.pathname.startsWith('/training/')
  if (onTraining) last.current = location.pathname.replace(/\/+$/, '')
  const id = last.current.split('/')[2] ?? null

  // Back on the list (the rail, 全部训练): no half-made choice is left open.
  useEffect(() => {
    if (!id) setPicking(false)
  }, [id])

  const open = useCallback(
    (project: TrainingProject) => {
      upsert(project)
      void navigate(`/training/${project.id}`)
    },
    [upsert, navigate],
  )

  async function create(kind: TrainingKind): Promise<void> {
    setCreating(kind)
    try {
      const project = await call<TrainingProject>(Ipc.trainingCreate, { kind, hostId: host.hostId })
      setPicking(false)
      open(project)
    } catch (reason) {
      toast.push(`没能新建训练：${errorText(reason)}`, 'error')
    } finally {
      setCreating(null)
    }
  }

  if (id) {
    return (
      <ProjectScreen
        key={id}
        id={id}
        sshHosts={host.sshHosts}
        onBack={() => void navigate('/training')}
        onChanged={upsert}
        onOpen={open}
        onRemoved={(removed) => {
          drop(removed)
          void navigate('/training')
        }}
      />
    )
  }

  const view = homeView(readiness, trainings, { picking })
  if (view === 'loading') return <LoadingRow className="px-8 py-6" />
  if (view === 'error')
    return (
      <div className="h-full bg-board px-8 py-8">
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={() => void refresh()}>
              重试
            </Button>
          }
        >
          没能读取训练的准备情况：{error}
        </Notice>
      </div>
    )
  if (view === 'blocked')
    return <Blocked readiness={readiness!} sshHosts={host.sshHosts} remoteHostsEnabled={remoteHostsEnabled} onUseHost={host.setHostId} />
  if (view === 'oobe') return <FirstUse readiness={readiness!} onPick={() => setPicking(true)} />
  if (view === 'start')
    return <StartTiles creating={creating} onPick={(kind) => void create(kind)} onBack={picking ? () => setPicking(false) : undefined} />
  return (
    <HomeList
      trainings={trainings ?? []}
      onOpen={(trainingId) => void navigate(`/training/${trainingId}`)}
      onNew={() => setPicking(true)}
    />
  )
}

/** One training, on its own computer: 位置 and readiness follow `project.hostId`, not the selected location. */
function ProjectScreen({
  id,
  sshHosts,
  onBack,
  onChanged,
  onOpen,
  onRemoved,
}: {
  id: string
  sshHosts: ManagedHost[]
  onBack: () => void
  onChanged: (project: TrainingProject) => void
  onOpen: (project: TrainingProject) => void
  onRemoved: (id: string) => void
}): React.JSX.Element {
  const [project, setProject] = useState<TrainingProject | null | undefined>(undefined)
  const [startProblem, setStartProblem] = useState<string | null>(null)
  const hostId = project?.hostId ?? null
  const { readiness } = useReadiness(hostId)
  const place = hostId ? placeOf(hostId, sshHosts, readiness) : ''

  useEffect(() => {
    let canceled = false
    void call<TrainingProject>(Ipc.trainingGet, { id })
      .then((next) => {
        if (!canceled) setProject(next)
      })
      .catch(() => {
        if (!canceled) setProject(null)
      })
    return () => {
      canceled = true
    }
  }, [id])

  useEffect(
    () =>
      onEvent<TrainingProject>(Events.trainingChanged, (next) => {
        if (next.id === id) setProject(next)
      }),
    [id],
  )

  const changed = useCallback(
    (next: TrainingProject) => {
      onChanged(next)
      // The editor keeps its own copy while it is a draft (only the location is followed here); a state change (开始训练) moves on.
      setProject((previous) =>
        previous && previous.state === 'draft' && next.state === 'draft' ? { ...previous, hostId: next.hostId } : next,
      )
    },
    [onChanged],
  )

  if (project === undefined) return <LoadingRow className="px-8 py-6" />
  if (project === null)
    return (
      <div className="flex h-full bg-board">
        <EmptyState
          title="找不到这个训练"
          description="它可能已经被删除了。"
          action={<Button onClick={onBack}>返回全部训练</Button>}
          className="flex-1"
        />
      </div>
    )

  const view = projectView(project.state)
  if (view === 'editor')
    return (
      <Editor
        key={project.id}
        initial={project}
        readiness={readiness}
        place={place}
        sshHosts={sshHosts}
        onSaved={changed}
        onBack={onBack}
        startProblem={startProblem}
        onStartProblem={setStartProblem}
      />
    )
  if (view === 'running') return <RunningView project={project} place={place} onBack={onBack} onChanged={changed} />
  return <ResultView project={project} place={place} onBack={onBack} onChanged={changed} onRemoved={onRemoved} onOpen={onOpen} />
}
