import { Plus } from 'lucide-react'
import { useState } from 'react'
import { languageProvider, seesPictures, visionProvider, type AiProviderInfo } from '@shared/ai'
import { Ipc } from '@shared/channels'
import { call } from '../../lib/api'
import { useProviders } from '../../lib/useProviders'
import { useApp } from '../../store'
import { ProviderDialog, type ModelNeed } from '../../components/common/ProviderDialog'
import { Button, ConfirmDialog, EmptyState, Group, LoadingRow, Row, Section, Select, Tag, useToast } from '../../components/ui'
import { SectionBody, errorText, useSaveSettings } from './fields'

const providerOption = (provider: AiProviderInfo): { value: string; label: string } => ({
  value: provider.id,
  label: `${provider.name} · ${provider.model}`,
})

/**
 * 设置 › 语言模型: the connected services and which one does what. The 助手's
 * 连接设置 and every action that asks for a model open the same dialog over
 * the same list.
 */
export function LanguageModelsSection(): React.JSX.Element {
  const settings = useApp((state) => state.settings)!
  const save = useSaveSettings()
  const toast = useToast()
  const { providers, loaded } = useProviders()
  // Kept while the dialog closes, so its title does not change on the way out.
  const [dialog, setDialog] = useState<{ open: boolean; editing?: AiProviderInfo; need?: ModelNeed }>({ open: false })
  const [removing, setRemoving] = useState<AiProviderInfo | null>(null)

  const language = languageProvider(providers, settings.languageProviderId)
  const vision = visionProvider(providers, settings.gbcProviderId)
  const seeing = providers.filter(seesPictures)

  async function remove(provider: AiProviderInfo): Promise<void> {
    setRemoving(null)
    try {
      await call(Ipc.aiProviderRemove, { id: provider.id })
      toast.push(`已移除「${provider.name}」`, 'success')
    } catch (error) {
      toast.push(errorText(error), 'error')
    }
  }

  if (!loaded) return <LoadingRow />

  return (
    <SectionBody>
      <Section
        title="已连接"
        actions={
          providers.length ? (
            <Button onClick={() => setDialog({ open: true })}>
              <Plus className="size-4" strokeWidth={1.6} aria-hidden="true" />
              连接语言模型
            </Button>
          ) : null
        }
      >
        <Group>
          {providers.length ? (
            providers.map((provider) => (
              <Row
                key={provider.id}
                title={
                  <span data-provider={provider.id} className="inline-flex max-w-full items-center gap-2">
                    <span className="truncate">{provider.name}</span>
                    {seesPictures(provider) ? <Tag>能看图</Tag> : null}
                  </span>
                }
                description={provider.model}
              >
                <Button tone="ghost" aria-label={`编辑 ${provider.name}`} onClick={() => setDialog({ open: true, editing: provider })}>
                  编辑
                </Button>
                <Button tone="ghost-danger" aria-label={`移除 ${provider.name}`} onClick={() => setRemoving(provider)}>
                  移除
                </Button>
              </Row>
            ))
          ) : (
            <EmptyState
              size="section"
              title="还没有连接语言模型"
              action={
                <Button tone="primary" onClick={() => setDialog({ open: true })}>
                  连接语言模型
                </Button>
              }
            />
          )}
        </Group>
      </Section>

      {providers.length ? (
        <Section title="谁来做">
          <Group>
            <Row title="助手和漫画" description="写描述、改画板、生成分镜">
              <Select
                aria-label="助手和漫画"
                className="w-[260px]"
                value={language?.id ?? ''}
                options={providers.map(providerOption)}
                onValueChange={(value) => void save({ languageProviderId: value })}
              />
            </Row>
            <Row title="看图" description="解析、拆成区域">
              {seeing.length ? (
                <Select
                  aria-label="看图"
                  className="w-[260px]"
                  value={vision?.id ?? ''}
                  options={seeing.map(providerOption)}
                  onValueChange={(value) => void save({ gbcProviderId: value })}
                />
              ) : (
                <Button onClick={() => setDialog({ open: true, need: { vision: true } })}>连接能看图的模型</Button>
              )}
            </Row>
          </Group>
        </Section>
      ) : null}

      <ProviderDialog
        open={dialog.open}
        editing={dialog.editing ?? null}
        need={dialog.need}
        onClose={() => setDialog((current) => ({ ...current, open: false }))}
      />
      <ConfirmDialog
        open={removing !== null}
        title={`移除「${removing?.name ?? ''}」？`}
        description="它的 API Key 也会从这台电脑上删除。"
        confirmLabel="移除"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) void remove(removing)
        }}
      />
    </SectionBody>
  )
}
