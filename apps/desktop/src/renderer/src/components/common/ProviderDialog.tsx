import { useCallback, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { AI_PROVIDER_PRESETS, PICTURE_KINDS, seesPictures, type AiProviderInfo, type AiProviderKind } from '@shared/ai'
import { Ipc } from '@shared/channels'
import { Button, Field, FieldLabel, IconButton, Input, Modal, Select, useToast } from '../ui'
import { call } from '../../lib/api'

const KIND_LABELS: Record<AiProviderKind, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  ollama: 'Ollama',
}

const ALL_KINDS = Object.keys(KIND_LABELS) as AiProviderKind[]

/** What an action needs from a language model. */
export interface ModelNeed {
  /** The action as its button names it (生成分镜); absent when nothing waits for the connection. */
  action?: string
  /** 看图: only what `seesPictures` accepts will do. */
  vision?: boolean
}

interface Draft {
  id?: string
  name: string
  kind: AiProviderKind
  baseUrl: string
  model: string
  apiKey: string
}

function draftFor(provider: AiProviderInfo | null | undefined, kind: AiProviderKind): Draft {
  return provider
    ? { id: provider.id, name: provider.name, kind: provider.kind, baseUrl: provider.baseUrl, model: provider.model, apiKey: '' }
    : { name: '', kind, baseUrl: '', model: '', apiKey: '' }
}

/**
 * Connect a language model service. The 助手, 设置 › 语言模型 and every action
 * that needs a model open this one dialog. Keys stay on this computer.
 */
export function ProviderDialog({
  open,
  providers = [],
  busy = false,
  need,
  editing,
  description = '密钥只保存在这台电脑上。',
  onClose,
  onChanged,
  onConnected,
}: {
  open: boolean
  /** Listed above the form to edit or delete; leave out where the page lists them itself. */
  providers?: AiProviderInfo[]
  busy?: boolean
  /** Opened by an action that needs a model: the title names it, and the connection runs it. */
  need?: ModelNeed
  /** Opens on this connection's form instead of an empty one. */
  editing?: AiProviderInfo | null
  description?: string
  onClose: () => void
  onChanged?: () => Promise<void>
  onConnected?: (provider: AiProviderInfo) => void
}): React.JSX.Element {
  const toast = useToast()
  const visionOnly = Boolean(need?.vision)
  const kinds = visionOnly ? PICTURE_KINDS : ALL_KINDS
  const [draft, setDraft] = useState<Draft>(() => draftFor(editing, kinds[0]!))
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (open) setDraft(draftFor(editing, (visionOnly ? PICTURE_KINDS : ALL_KINDS)[0]!))
  }, [open, editing, visionOnly])

  async function save(): Promise<void> {
    if (!draft.name.trim() || !draft.baseUrl.trim() || !draft.model.trim()) {
      toast.push('名称、地址和模型都要填写', 'error')
      return
    }
    if (need?.vision && !draft.apiKey.trim() && !draft.id) {
      toast.push('看图要填 API Key', 'error')
      return
    }
    setSaving(true)
    try {
      const saved = await call<AiProviderInfo>(Ipc.aiProviderSave, { ...draft, apiKey: draft.apiKey || undefined, temperature: 0.7 })
      if (!need?.action) toast.push('已保存', 'success')
      setDraft(draftFor(null, kinds[0]!))
      await onChanged?.()
      onClose()
      onConnected?.(saved)
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await call(Ipc.aiProviderRemove, { id })
      await onChanged?.()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const listed = need ? [] : providers
  const title = need?.action ? `${need.action}要用语言模型` : editing ? `编辑「${editing.name}」` : '连接语言模型'
  const confirm = need?.action ? `连接并${need.action}` : draft.id ? '保存修改' : '添加'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      width="max-w-2xl"
      footer={
        <>
          <Button tone="ghost" size="md" onClick={onClose}>
            取消
          </Button>
          <Button tone="primary" size="md" disabled={saving} onClick={() => void save()}>
            {confirm}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {listed.length ? (
          <section className="flex flex-col gap-1">
            <FieldLabel as="h3">已连接</FieldLabel>
            {listed.map((provider) => (
              <div key={provider.id} className="flex items-center gap-2 rounded-lg bg-panel py-1 pl-3 pr-1">
                <span className="min-w-0 flex-1 truncate text-ui text-ink">
                  {provider.name}
                  <span className="text-ink-2"> · {provider.model}</span>
                </span>
                <Button tone="ghost" size="sm" onClick={() => setDraft(draftFor(provider, provider.kind))}>
                  编辑
                </Button>
                <IconButton label={`删除 ${provider.name}`} disabled={busy} onClick={() => void remove(provider.id)}>
                  <Trash2 className="size-4" strokeWidth={1.6} />
                </IconButton>
              </div>
            ))}
          </section>
        ) : null}

        <section className="flex flex-col gap-3">
          {listed.length ? <FieldLabel as="h3">{draft.id ? `编辑「${draft.name}」` : '添加新的'}</FieldLabel> : null}
          {!draft.id ? (
            <div className="flex flex-wrap gap-1.5">
              {AI_PROVIDER_PRESETS.filter((preset) => kinds.includes(preset.kind)).map((preset) => (
                <Button
                  key={preset.name}
                  tone="secondary"
                  size="sm"
                  onClick={() => setDraft({ ...draft, name: preset.name, kind: preset.kind, baseUrl: preset.baseUrl, model: preset.model })}
                >
                  {preset.name}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="名称">
              <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </Field>
            <Field label="接口类型">
              <Select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as AiProviderKind })}>
                {kinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_LABELS[kind]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="地址" className="col-span-2">
              <Input
                value={draft.baseUrl}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                placeholder="https://api.openai.com/v1"
              />
            </Field>
            <Field label="模型">
              <Input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
            </Field>
            <Field label="API Key">
              <Input
                type="password"
                value={draft.apiKey}
                onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                placeholder={draft.id ? '留空则保留原来的' : 'sk-...'}
              />
            </Field>
          </div>
        </section>
      </div>
    </Modal>
  )
}

/** Whether a suitable model is connected for this need. */
export function hasModelFor(need: ModelNeed, providers: readonly AiProviderInfo[]): boolean {
  return need.vision ? providers.some(seesPictures) : providers.length > 0
}

/**
 * An action that needs a language model stays clickable: `require` runs it at
 * once when a suitable model is connected, else opens ProviderDialog right
 * there and runs it with the new connection. Cancelling runs nothing.
 */
export function useModelGate(): {
  require: (need: ModelNeed & { action: string }, run: (connected?: AiProviderInfo) => void) => Promise<void>
  dialog: React.JSX.Element
} {
  const [asking, setAsking] = useState<{ need: ModelNeed; run: (connected?: AiProviderInfo) => void; open: boolean } | null>(null)

  const require = useCallback(async (need: ModelNeed & { action: string }, run: (connected?: AiProviderInfo) => void) => {
    // Asked at the click: another page may have connected or removed one since this one loaded.
    const providers = await call<AiProviderInfo[]>(Ipc.aiProvidersList).catch(() => [])
    if (hasModelFor(need, providers)) run()
    else setAsking({ need, run, open: true })
  }, [])

  const dialog = (
    <ProviderDialog
      open={Boolean(asking?.open)}
      need={asking?.need}
      // The need stays while the dialog closes, so its title does not change on the way out.
      onClose={() => setAsking((current) => (current ? { ...current, open: false } : null))}
      onConnected={(provider) => asking?.run(provider)}
    />
  )
  return { require, dialog }
}
