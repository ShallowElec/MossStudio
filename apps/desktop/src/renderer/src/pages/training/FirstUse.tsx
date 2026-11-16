import { Box, Cpu, GraduationCap, HardDrive, MemoryStick, Monitor, Plus, Wrench, type LucideIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Ipc } from '@shared/channels'
import type { TrainingReadiness } from '@shared/training'
import type { ManagedHost } from '@shared/types'
import { call } from '../../lib/api'
import { useApp } from '../../store'
import { Notice } from '../../components/common/Notice'
import { Advanced, Button, Group, Pill, ProgressBar, Row, Section, Spinner, useToast } from '../../components/ui'
import { TrainerCredit } from './TrainerCredit'
import { baseModelTasks, blockedText, checkRows, type CheckRow } from './trainingModel'
import { errorText } from './useTraining'

const ROW_ICON: Record<CheckRow['id'], LucideIcon> = { gpu: Cpu, ram: MemoryStick, model: Box, trainer: Wrench, disk: HardDrive }

/** The centred column the first-use screens share. */
function Column({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="h-full overflow-y-auto bg-board">
      <div className="mx-auto flex w-full max-w-[600px] flex-col gap-7 px-6 pb-16 pt-16">{children}</div>
    </div>
  )
}

function Heading({ title, description }: { title: string; description: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      {/* First use of a feature reads like first-run setup (ui-rules §2: text-display). */}
      <h1 className="text-display font-semibold text-ink">{title}</h1>
      <p className="text-control text-ink-2">{description}</p>
    </div>
  )
}

function CheckLine({ row }: { row: CheckRow }): React.JSX.Element {
  const Icon = ROW_ICON[row.id]
  const busy = row.progress !== undefined
  return (
    <div className="flex min-h-14 items-start gap-3 rounded-lg px-3.5 py-3.5" data-check-row={row.id}>
      <Icon className="mt-0.5 size-4 shrink-0 text-ink-2" strokeWidth={1.6} aria-hidden="true" />
      <span className="w-[72px] shrink-0 text-control text-ink">{row.title}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="truncate text-control text-ink-2">{row.value}</span>
        {busy ? <ProgressBar value={row.progress ?? null} label={`${row.title}进度`} /> : null}
        {row.detail ? <span className="tabular text-caption text-ink-2">{row.detail}</span> : null}
      </span>
      <Pill tone={row.pill.tone} className="tabular">
        {row.pill.text}
      </Pill>
    </div>
  )
}

/**
 * First use: what this computer has for training, and one button that gets
 * the base model, the trainer and its environment. While that runs, picking
 * pictures can already start (先选图片).
 */
export function FirstUse({ readiness, onPick }: { readiness: TrainingReadiness; onPick: () => void }): React.JSX.Element {
  const navigate = useNavigate()
  const toast = useToast()
  const downloads = useApp((state) => state.downloads)
  const catalog = useApp((state) => state.catalog)
  const trainerRoot = useApp((state) => state.settings?.trainerRoot ?? null)
  const [starting, setStarting] = useState(false)
  const bundle = catalog?.bundles.find((item) => item.id === readiness.baseModel.bundleId)
  const rows = useMemo(() => checkRows(readiness, baseModelTasks(bundle, downloads)), [readiness, bundle, downloads])
  const preparing = readiness.prepare.running

  async function prepare(): Promise<void> {
    setStarting(true)
    try {
      await call(Ipc.trainingPrepare, { hostId: readiness.hostId })
    } catch (error) {
      toast.push(`没能开始准备：${errorText(error)}`, 'error')
    } finally {
      setStarting(false)
    }
  }

  return (
    <Column>
      <Heading title="训练你自己的 LoRA" description="用几十张图片，教会模型一个人物、一种画风或一件物品。" />
      <Group tone="surface" className="p-1">
        {rows.map((row) => (
          <CheckLine key={row.id} row={row} />
        ))}
      </Group>
      {readiness.prepare.error ? (
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={() => void prepare()}>
              重试
            </Button>
          }
        >
          {readiness.prepare.error}
        </Notice>
      ) : null}
      <div className="flex items-center gap-3">
        {preparing ? (
          <Button tone="primary" size="lg" onClick={onPick}>
            <Plus className="size-4" strokeWidth={1.6} aria-hidden="true" />
            先选图片
          </Button>
        ) : (
          <Button tone="primary" size="lg" disabled={starting || !readiness.disk.ok} onClick={() => void prepare()}>
            {starting ? <Spinner /> : null}
            准备训练
          </Button>
        )}
        {preparing ? null : (
          <Button tone="ghost" size="md" onClick={() => void navigate('/studio')}>
            以后再说
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <Advanced dense summary={`${trainerRoot ?? '默认位置'} · 自动选择下载源`} className="-mx-3.5">
          <Row title="训练器的位置和下载源">
            <Button onClick={() => void navigate('/settings/training')}>去设置</Button>
          </Row>
        </Advanced>
        <TrainerCredit />
      </div>
    </Column>
  )
}

/** This computer cannot train: say why, offer another computer, or turn the feature off. */
export function Blocked({
  readiness,
  sshHosts,
  remoteHostsEnabled,
  onUseHost,
}: {
  readiness: TrainingReadiness
  sshHosts: ManagedHost[]
  remoteHostsEnabled: boolean
  onUseHost: (id: string) => void
}): React.JSX.Element {
  const navigate = useNavigate()
  const saveSettings = useApp((state) => state.saveSettings)
  const toast = useToast()
  const gpu = checkRows(readiness).find((row) => row.id === 'gpu')!

  async function turnOff(): Promise<void> {
    try {
      await saveSettings({ trainingEnabled: false })
      void navigate('/studio')
    } catch (error) {
      toast.push(`没有保存：${errorText(error)}`, 'error')
    }
  }

  return (
    <Column>
      <div className="flex size-14 items-center justify-center rounded-full bg-well text-ink-2">
        <GraduationCap className="size-6" strokeWidth={1.6} aria-hidden="true" />
      </div>
      <Heading title={readiness.hostId === 'local' ? '这台电脑不能训练' : '这台远程电脑不能训练'} description={blockedText(readiness)} />
      <Group tone="surface" className="p-1">
        <CheckLine row={gpu} />
      </Group>
      {remoteHostsEnabled ? (
        <Section title="用另一台电脑训练">
          {sshHosts.length ? (
            <Group tone="surface">
              {sshHosts.map((host) => (
                <Row
                  key={host.id}
                  leading={<Monitor className="size-4 text-ink-2" strokeWidth={1.6} aria-hidden="true" />}
                  title={host.name}
                  description={host.remote?.gpu ?? host.host}
                >
                  <Button onClick={() => onUseHost(host.id)}>在这台训练</Button>
                </Row>
              ))}
            </Group>
          ) : null}
          <div>
            <Button tone="ghost" onClick={() => void navigate('/settings/devices')}>
              <Plus className="size-4" strokeWidth={1.6} aria-hidden="true" />
              添加一台电脑
            </Button>
          </div>
        </Section>
      ) : null}
      <div>
        <Button tone="ghost" size="md" onClick={() => void turnOff()}>
          关闭训练功能
        </Button>
      </div>
    </Column>
  )
}
