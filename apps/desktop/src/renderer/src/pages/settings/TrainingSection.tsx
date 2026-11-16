import type { TrainerVersion, TrainingHost } from '@shared/types'
import { useApp } from '../../store'
import { Advanced, Button, Group, Pill, Row, Section, Spinner } from '../../components/ui'
import { TrainerAdvanced } from '../training/TrainerAdvanced'
import { TrainerCredit } from '../training/TrainerCredit'
import { TrainerSection, useTrainerUpdate, useUpdateTrack } from '../training/TrainerSection'
import { RUNTIME_LABEL, currentVersion, optionalUrlError, versionsAt } from '../training/trainerSetup'
import { useTrainerData } from '../training/useTrainerData'
import { FolderRow, SectionBody, TextSetting, useSaveSettings } from './fields'

function RemoteTrainer({
  host,
  versions,
  onChanged,
}: {
  host: TrainingHost
  versions: TrainerVersion[]
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const [track] = useUpdateTrack()
  const { step, update } = useTrainerUpdate(host.id, versions, onChanged)
  const version = currentVersion(versions, host.id)
  const description = [host.remote?.gpu ?? host.host, version ? `训练器 ${version.shortCommit}` : '还没有训练器']
    .filter(Boolean)
    .join(' · ')
  return (
    <Row title={host.name} description={description}>
      {version ? (
        <Pill tone={version.runtimeState === 'ready' ? 'ok' : version.runtimeState === 'error' ? 'danger' : 'neutral'}>
          {RUNTIME_LABEL[version.runtimeState]}
        </Pill>
      ) : null}
      <Button onClick={() => void update(track)} disabled={step !== null}>
        {step ? <Spinner /> : null}
        {version ? '检查更新' : '准备训练器'}
      </Button>
    </Row>
  )
}

/**
 * 设置 › 训练: the trainer's plumbing, out of the way of the 训练 page. Its
 * version and environment, where it lives and downloads from, the remote
 * computers' trainers, other versions under 高级, and whose trainer it is.
 */
export function TrainingSection(): React.JSX.Element {
  const settings = useApp((state) => state.settings)!
  const save = useSaveSettings()
  const { hosts, sshHosts, versions, loading, refresh } = useTrainerData()
  const local = hosts.find((host) => host.id === 'local')
  const others = Math.max(0, versionsAt(versions, 'local').length - 1)

  return (
    <SectionBody>
      <TrainerSection versions={versions} loading={loading} onChanged={refresh} />

      <Section title="位置与下载">
        <Group>
          <FolderRow
            title="训练器文件夹"
            value={settings.trainerRoot}
            fallback={local?.trainerRoot ?? null}
            pickTitle="选择训练器文件夹"
            onChange={(trainerRoot) => save({ trainerRoot })}
          />
          <TextSetting<string | null>
            inline
            mono
            title="PyTorch 下载源"
            value={settings.torchIndex}
            placeholder="自动"
            validate={optionalUrlError}
            parse={(text) => text.trim() || null}
            inputClassName="w-[280px]"
            onSave={(torchIndex) => save({ torchIndex })}
          />
          <TextSetting<string | null>
            inline
            mono
            title="pip 下载源"
            value={settings.pipIndex}
            placeholder="自动"
            validate={optionalUrlError}
            parse={(text) => text.trim() || null}
            inputClassName="w-[280px]"
            onSave={(pipIndex) => save({ pipIndex })}
          />
        </Group>
      </Section>

      {settings.remoteHostsEnabled && sshHosts.length ? (
        <Section title="远程电脑">
          <Group>
            {sshHosts.map((host) => (
              <RemoteTrainer key={host.id} host={host} versions={versions} onChanged={refresh} />
            ))}
          </Group>
        </Section>
      ) : null}

      <Advanced summary={others ? `其他版本 ${others} 个` : 'Python、PyTorch 和训练器版本'} className="-mx-3.5">
        <TrainerAdvanced hostId="local" versions={versions} busy={false} onChanged={refresh} />
      </Advanced>

      <TrainerCredit className="px-1" />
    </SectionBody>
  )
}
