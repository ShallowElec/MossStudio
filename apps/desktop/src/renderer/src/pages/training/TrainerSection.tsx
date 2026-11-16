import { useState } from 'react'
import { Ipc } from '@shared/channels'
import type { TrainerVersion } from '@shared/types'
import { call } from '../../lib/api'
import { dateTime } from '../../lib/format'
import { useApp } from '../../store'
import { Button, Group, Pill, Row, Section, Select, Spinner, useToast } from '../../components/ui'
import { DoctorDialog, type DoctorResult } from './DoctorDialog'
import { PREPARE_STEP_LABEL, currentVersion, prepareTrainer, trainerApi, type PrepareStep, type UpdateTrack } from './trainerSetup'
import { errorText, readPreference, writePreference } from './useTraining'

const TRACK_KEY = 'mossstudio.training.updateTrack'

/** 更新到, remembered per person: the stable release unless they asked for the newest. */
export function useUpdateTrack(): [UpdateTrack, (track: UpdateTrack) => void] {
  const [track, setTrack] = useState<UpdateTrack>(() => (readPreference(TRACK_KEY) === 'latest' ? 'latest' : 'stable'))
  return [
    track,
    (next) => {
      setTrack(next)
      writePreference(TRACK_KEY, next)
    },
  ]
}

/** The environment's state in a word or two; the row title already says 环境. */
const RUNTIME_STATE: Record<TrainerVersion['runtimeState'], string> = {
  missing: '未安装',
  created: '未装完',
  installing: '正在安装',
  ready: '就绪',
  error: '安装失败',
}

function runtimeTone(state: TrainerVersion['runtimeState'] | undefined): 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' {
  if (state === 'ready') return 'ok'
  if (state === 'installing') return 'accent'
  if (state === 'error') return 'danger'
  if (state === 'created') return 'warn'
  return 'neutral'
}

/**
 * Bring one location's trainer up to date, the same way from every row:
 * the version on the 更新到 track, its environment installed.
 */
export function useTrainerUpdate(
  hostId: string,
  versions: TrainerVersion[],
  onChanged: () => Promise<void>,
): { step: PrepareStep | null; upToDate: boolean; update: (track: UpdateTrack) => Promise<void> } {
  const toast = useToast()
  const [step, setStep] = useState<PrepareStep | null>(null)
  const [upToDate, setUpToDate] = useState(false)
  const version = currentVersion(versions, hostId)

  async function update(track: UpdateTrack): Promise<void> {
    if (step) return
    try {
      const result = await prepareTrainer(trainerApi(call, hostId), version, setStep, track)
      setUpToDate(!result.updated)
      toast.push(
        !version ? '训练器已准备好' : result.updated ? `训练器已更新到 ${result.version.shortCommit}` : '训练器已是最新',
        'success',
      )
    } catch (error) {
      toast.push(`更新训练器失败：${errorText(error)}`, 'error')
    } finally {
      setStep(null)
      await onChanged().catch(() => undefined)
    }
  }

  return { step, upToDate, update }
}

/** 设置 › 训练 › 训练器: this computer's version, where updates come from, and its environment. */
export function TrainerSection({
  versions,
  loading,
  onChanged,
}: {
  versions: TrainerVersion[]
  loading: boolean
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const toast = useToast()
  const env = useApp((state) => state.env)
  const torchBackend = useApp((state) => state.settings?.torchBackend ?? 'auto')
  const [track, setTrack] = useUpdateTrack()
  const { step, upToDate, update } = useTrainerUpdate('local', versions, onChanged)
  const [installing, setInstalling] = useState(false)
  const [checking, setChecking] = useState(false)
  const [doctor, setDoctor] = useState<DoctorResult | null>(null)
  const version = currentVersion(versions, 'local')
  const busy = step !== null || installing

  async function install(target: TrainerVersion): Promise<void> {
    setInstalling(true)
    try {
      await trainerApi(call, 'local').install(target)
      toast.push('训练环境已就绪', 'success')
    } catch (error) {
      toast.push(`安装训练环境失败：${errorText(error)}`, 'error')
    } finally {
      setInstalling(false)
      await onChanged().catch(() => undefined)
    }
  }

  async function runDoctor(target: TrainerVersion): Promise<void> {
    setChecking(true)
    try {
      setDoctor(await call<DoctorResult>(Ipc.trainerDoctor, { id: target.id }))
    } catch (error) {
      toast.push(`体检没有完成：${errorText(error)}`, 'error')
    } finally {
      setChecking(false)
    }
  }

  const python = env?.pythons[0]?.version
  const environment = [python ? `Python ${python}` : '', torchBackend === 'cpu' ? 'PyTorch CPU' : 'PyTorch CUDA']
    .filter(Boolean)
    .join(' · ')

  return (
    <Section title="训练器">
      <Group>
        <Row
          title="版本"
          description={
            step
              ? PREPARE_STEP_LABEL[step]
              : version
                ? `${version.shortCommit} · ${version.branch} · ${dateTime(version.commitDate)}${version.dirty ? ' · 有本地修改' : ''}`
                : loading
                  ? '正在读取…'
                  : '还没有训练器'
          }
        >
          {step ? (
            <Pill tone="accent">正在更新</Pill>
          ) : version ? (
            <Pill tone="ok">{upToDate ? '已是最新' : '已准备'}</Pill>
          ) : (
            <Pill>未准备</Pill>
          )}
          <Button onClick={() => void update(track)} disabled={busy || loading}>
            {step ? <Spinner /> : null}
            {version ? '检查更新' : '准备训练器'}
          </Button>
        </Row>
        <Row title="更新到">
          <Select
            aria-label="更新到"
            className="w-[160px]"
            value={track}
            options={[
              { value: 'stable', label: '稳定版' },
              { value: 'latest', label: '最新' },
            ]}
            onValueChange={(value) => setTrack(value as UpdateTrack)}
          />
        </Row>
        <Row title="环境" description={version ? environment : undefined}>
          <Pill tone={runtimeTone(version?.runtimeState)}>{version ? RUNTIME_STATE[version.runtimeState] : '未安装'}</Pill>
          {version && version.runtimeState !== 'ready' ? (
            <Button onClick={() => void install(version)} disabled={busy}>
              {installing ? <Spinner /> : null}
              {version.runtimeState === 'error' ? '重新安装' : '安装环境'}
            </Button>
          ) : null}
          {version?.runtimeState === 'ready' ? (
            <Button tone="ghost" onClick={() => void runDoctor(version)} disabled={checking || busy}>
              {checking ? <Spinner /> : null}
              体检
            </Button>
          ) : null}
        </Row>
      </Group>
      <DoctorDialog result={doctor} onClose={() => setDoctor(null)} />
    </Section>
  )
}
