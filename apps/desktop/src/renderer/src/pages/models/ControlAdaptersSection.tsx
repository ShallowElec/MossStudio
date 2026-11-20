import { SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { Ipc } from '@shared/channels'
import type { ControlAdapterEntry } from '@shared/types'
import { isSharedModelId } from '@shared/sharedModels'
import { ConfirmDialog, EmptyState, Group, Row, Section, Tag, useToast } from '../../components/ui'
import { call } from '../../lib/api'
import { useControlAdapters } from '../../lib/useControlAdapters'
import { controlKindLabel } from '../studio/links'
import { useEngineFeatures } from '../studio/useEngineFeatures'
import { RemoveButton, SizeText } from './ModelEntries'

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/**
 * 控制适配器: files that let a generation follow a depth, edge or pose picture.
 * They come in through 导入模型 (the engine checks each file) and are chosen per
 * canvas in 创作. Hidden when this computer's engine cannot use them.
 */
export function ControlAdaptersSection(): React.JSX.Element | null {
  const toast = useToast()
  const features = useEngineFeatures({})
  const { adapters, refresh } = useControlAdapters()
  const [removing, setRemoving] = useState<ControlAdapterEntry | null>(null)

  if (features && !features.control && adapters.length === 0) return null

  async function remove(entry: ControlAdapterEntry): Promise<void> {
    setRemoving(null)
    try {
      await call(Ipc.controlAdaptersRemove, { id: entry.id })
      refresh()
      toast.push(`已移除 ${entry.name}`, 'success')
    } catch (cause) {
      toast.push(`没能移除：${errorText(cause)}`, 'error')
    }
  }

  return (
    <Section title="控制适配器" description="让生成按深度、边缘或姿态图来构图。在创作的「输入 › 控制」里选用。">
      <Group>
        {adapters.length ? (
          adapters.map((entry) => (
            <Row
              key={entry.id}
              title={entry.name}
              description={
                <span className="flex flex-wrap items-center gap-1.5">
                  {entry.controlKinds.map((kind) => (
                    <Tag key={kind}>{controlKindLabel(kind)}</Tag>
                  ))}
                </span>
              }
            >
              <SizeText bytes={entry.sizeBytes} />
              {isSharedModelId(entry.id) ? null : <RemoveButton remove name={entry.name} onClick={() => setRemoving(entry)} />}
            </Row>
          ))
        ) : (
          <EmptyState
            size="section"
            icon={<SlidersHorizontal className="size-6" strokeWidth={1.6} />}
            title="还没有控制适配器"
            description="用「导入模型」加入电脑上的控制适配器文件。"
          />
        )}
      </Group>

      <ConfirmDialog
        open={Boolean(removing)}
        title={removing ? `移除「${removing.name}」？` : ''}
        description="只从列表里移除，文件本身不会删除。用它的画面需要重新选一个适配器。"
        confirmLabel="移除"
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && void remove(removing)}
      />
    </Section>
  )
}
