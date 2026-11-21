import { Check, Pencil, Plus, ScanSearch, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { ADAPTER_STRENGTH_MAX, ADAPTER_STRENGTH_MIN, formatAdapterStrength } from '@shared/adapters'
import type { CanvasAdapter } from '@shared/types'
import { addTrigger, promptHasTrigger, removeTrigger } from '../../pages/studio/prompt'
import { Button, Field, IconButton, Input, Modal, Segmented, Spinner, Textarea, cn, useToast } from '../ui'
import {
  AUTO_INSERT_LABELS,
  cleanTriggers,
  loraProfileKey,
  loraProfileStore,
  parseTriggerText,
  type LoraAutoInsert,
  type LoraProfile,
  type LoraProfileStore,
} from './loraProfilesClient'

const CHIP = 'inline-flex h-5 min-w-0 max-w-full items-center gap-0.5 rounded-full px-2 text-caption transition-colors disabled:opacity-40'

/** What clicking a chip does to the description; pure so it can be tested without React. */
export function toggleTriggerInDescription(description: string, trigger: string): string {
  return promptHasTrigger(description, trigger) ? removeTrigger(description, trigger) : addTrigger(description, trigger)
}

/**
 * The trigger words of one chosen LoRA, under its strength slider. A word in
 * the description is highlighted and clicking takes it out; the others add it.
 */
export function LoraTriggerBar({
  adapter,
  name,
  profile,
  description,
  readOnly = false,
  onDescriptionChange,
  store = loraProfileStore,
}: {
  adapter: CanvasAdapter
  name: string
  profile: LoraProfile | undefined
  description: string
  readOnly?: boolean
  onDescriptionChange?: (update: (description: string) => string) => void
  store?: LoraProfileStore
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const toast = useToast()
  const key = loraProfileKey(adapter)
  const triggers = profile?.triggers ?? []
  const suggested = profile?.suggestedTriggers ?? []
  const auto = profile?.autoInsert && profile.autoInsert !== 'manual' ? profile.autoInsert : null
  const canWrite = !readOnly && Boolean(onDescriptionChange)

  async function adopt(word: string): Promise<void> {
    onDescriptionChange?.((current) => addTrigger(current, word))
    try {
      await store.save({
        loraId: key,
        triggers: cleanTriggers([...triggers, word]),
        ...(profile?.negativeTriggers ? { negativeTriggers: profile.negativeTriggers } : {}),
        ...(profile?.defaultStrength !== undefined ? { defaultStrength: profile.defaultStrength } : {}),
        ...(profile?.autoInsert ? { autoInsert: profile.autoInsert } : {}),
        ...(profile?.notes ? { notes: profile.notes } : {}),
      })
    } catch (error) {
      toast.push(`已写入描述，但触发词没有保存：${error instanceof Error ? error.message : String(error)}`, 'info')
    }
  }

  return (
    <div className="flex min-w-0 items-start gap-1" data-lora-triggers={key}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {auto ? (
          <span
            className="inline-flex h-5 shrink-0 items-center rounded-md bg-accent-soft px-1.5 text-micro text-ink"
            data-trigger-auto={auto}
          >
            {AUTO_INSERT_LABELS[auto]}
          </span>
        ) : null}
        {triggers.map((word) => {
          const present = promptHasTrigger(description, word)
          return (
            <button
              key={word}
              type="button"
              disabled={!canWrite}
              aria-pressed={present}
              data-trigger-chip={word}
              data-trigger-state={present ? 'in' : 'out'}
              title={present ? `从描述里去掉「${word}」` : `加到描述`}
              onClick={() => onDescriptionChange?.((current) => toggleTriggerInDescription(current, word))}
              className={cn(CHIP, present ? 'bg-accent-soft font-medium text-ink' : 'bg-well-strong text-ink-2 enabled:hover:text-ink')}
            >
              {present ? <Check className="size-3 shrink-0" aria-hidden="true" strokeWidth={1.8} /> : null}
              <span className="truncate">{word}</span>
            </button>
          )
        })}
        {suggested.map((word) => (
          <button
            key={`suggested-${word}`}
            type="button"
            disabled={!canWrite}
            data-trigger-chip={word}
            data-trigger-state="suggested"
            title={`采用「${word}」`}
            onClick={() => void adopt(word)}
            className={cn(CHIP, 'bg-transparent text-ink-2 enabled:hover:bg-well-strong enabled:hover:text-ink')}
          >
            <Sparkles className="size-3 shrink-0" aria-hidden="true" strokeWidth={1.6} />
            <span className="truncate">{word}</span>
          </button>
        ))}
        {!triggers.length && !suggested.length ? <span className="text-caption text-ink-3">没有触发词</span> : null}
      </div>
      {readOnly ? null : (
        <IconButton
          label={`编辑「${name}」的触发词`}
          className="size-6 shrink-0"
          data-lora-trigger-edit={key}
          onClick={() => setEditing(true)}
        >
          <Pencil className="size-3" strokeWidth={1.6} />
        </IconButton>
      )}
      {editing ? (
        <LoraTriggerDialog adapter={adapter} name={name} profile={profile} store={store} onClose={() => setEditing(false)} />
      ) : null}
    </div>
  )
}

const AUTO_ORDER: readonly LoraAutoInsert[] = ['manual', 'prefix', 'suffix']

const PREVIEW_WORDS = 4

/** A compact line for a picker row: the first trigger words, the recommended strength, the note. Plain spans, so it can sit inside a button. */
export function LoraProfileHint({ profile }: { profile: LoraProfile | undefined }): React.JSX.Element | null {
  if (!profile) return null
  const words = profile.triggers.length ? profile.triggers : (profile.suggestedTriggers ?? [])
  const suggestedOnly = !profile.triggers.length && words.length > 0
  if (!words.length && profile.defaultStrength === undefined && !profile.notes) return null
  return (
    <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1" data-lora-profile-hint={profile.loraId}>
      {words.slice(0, PREVIEW_WORDS).map((word) => (
        <span
          key={word}
          className={cn(
            'inline-flex h-4 min-w-0 max-w-[10rem] items-center gap-0.5 rounded-full px-1.5 text-micro',
            suggestedOnly ? 'text-ink-2' : 'bg-accent-soft text-ink',
          )}
        >
          {suggestedOnly ? <Sparkles className="size-2.5 shrink-0" aria-hidden="true" strokeWidth={1.6} /> : null}
          <span className="truncate">{word}</span>
        </span>
      ))}
      {words.length > PREVIEW_WORDS ? <span className="text-micro text-ink-2">+{words.length - PREVIEW_WORDS}</span> : null}
      {profile.defaultStrength !== undefined ? (
        <span className="tabular text-micro text-ink-2">推荐强度 {formatAdapterStrength(profile.defaultStrength)}</span>
      ) : null}
      {profile.notes ? (
        <span className="min-w-0 max-w-full truncate text-micro text-ink-2" title={profile.notes}>
          {profile.notes}
        </span>
      ) : null}
    </span>
  )
}

/** Trigger words, negative words, recommended strength, automatic insertion and notes of one LoRA. */
export function LoraTriggerDialog({
  adapter,
  name,
  profile,
  store = loraProfileStore,
  onClose,
}: {
  adapter: CanvasAdapter
  name: string
  profile: LoraProfile | undefined
  store?: LoraProfileStore
  onClose: () => void
}): React.JSX.Element {
  const key = loraProfileKey(adapter)
  const toast = useToast()
  const [triggers, setTriggers] = useState(() => (profile?.triggers ?? []).join(', '))
  const [negative, setNegative] = useState(() => (profile?.negativeTriggers ?? []).join(', '))
  const [strength, setStrength] = useState(() => (profile?.defaultStrength !== undefined ? String(profile.defaultStrength) : ''))
  const [mode, setMode] = useState<LoraAutoInsert>(profile?.autoInsert ?? 'manual')
  const [notes, setNotes] = useState(profile?.notes ?? '')
  const [found, setFound] = useState<string[]>(() => profile?.suggestedTriggers ?? [])
  const [inspecting, setInspecting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [inspectNote, setInspectNote] = useState('')

  const parsedStrength = strength.trim() === '' ? undefined : Number(strength)
  const strengthValid =
    parsedStrength === undefined ||
    (Number.isFinite(parsedStrength) && parsedStrength >= ADAPTER_STRENGTH_MIN && parsedStrength <= ADAPTER_STRENGTH_MAX)
  const current = parseTriggerText(triggers)
  const pending = found.filter((word) => !current.some((item) => item.toLowerCase() === word.toLowerCase()))

  async function inspect(): Promise<void> {
    setInspecting(true)
    setInspectNote('')
    try {
      const result = await store.inspect({ loraId: key, ...(adapter.path ? { path: adapter.path } : {}) })
      if (!result) {
        setInspectNote('这个版本还不能读取文件头里的触发词')
        return
      }
      const words = cleanTriggers([...result.triggers, ...result.suggestedTriggers])
      setFound(words)
      if (!current.length && result.triggers.length) setTriggers(result.triggers.join(', '))
      setInspectNote(
        words.length ? `识别到 ${words.length} 个候选词${result.source ? `（来自 ${result.source}）` : ''}` : '文件头里没有找到触发词',
      )
    } catch (error) {
      setInspectNote(error instanceof Error ? error.message : String(error))
    } finally {
      setInspecting(false)
    }
  }

  async function save(): Promise<void> {
    if (!strengthValid || saving) return
    setSaving(true)
    try {
      const negativeTriggers = parseTriggerText(negative)
      await store.save({
        loraId: key,
        triggers: current,
        ...(negativeTriggers.length ? { negativeTriggers } : {}),
        ...(parsedStrength !== undefined ? { defaultStrength: Math.round(parsedStrength * 100) / 100 } : {}),
        autoInsert: mode,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      })
      toast.push(`已保存「${name}」的触发词`, 'success')
      onClose()
    } catch (error) {
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      title="编辑 LoRA 触发词"
      description={name}
      onClose={onClose}
      width="max-w-lg"
      footer={
        <>
          <Button tone="ghost" size="md" onClick={onClose}>
            取消
          </Button>
          <Button tone="primary" size="md" disabled={!strengthValid || saving} data-lora-trigger-save onClick={() => void save()}>
            {saving ? <Spinner className="size-4" /> : null}
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4" data-lora-trigger-dialog={key}>
        <Field label="触发词">
          <Textarea
            value={triggers}
            rows={2}
            maxLength={2000}
            spellCheck={false}
            data-dialog-initial-focus
            placeholder="例如：sks style, watercolor"
            onChange={(event) => setTriggers(event.target.value)}
            className="resize-none"
          />
        </Field>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" disabled={inspecting} data-lora-trigger-inspect onClick={() => void inspect()}>
              {inspecting ? <Spinner className="size-3" /> : <ScanSearch className="size-3.5" aria-hidden="true" strokeWidth={1.6} />}
              从文件读取
            </Button>
            {inspectNote ? <span className="text-caption text-ink-2">{inspectNote}</span> : null}
          </div>
          {pending.length ? (
            <div className="flex flex-wrap gap-1">
              {pending.map((word) => (
                <button
                  key={word}
                  type="button"
                  data-trigger-candidate={word}
                  title={`采纳「${word}」`}
                  onClick={() => setTriggers((value) => [...parseTriggerText(value), word].join(', '))}
                  className={cn(CHIP, 'bg-well text-ink-2 hover:bg-well-strong hover:text-ink')}
                >
                  <Plus className="size-3 shrink-0" aria-hidden="true" strokeWidth={1.6} />
                  <span className="truncate">{word}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <Field label="负向词备注">
          <Input value={negative} maxLength={2000} spellCheck={false} onChange={(event) => setNegative(event.target.value)} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <Field label="推荐强度" hint={strengthValid ? undefined : '请填 0 到 2'}>
            <Input
              inputMode="decimal"
              className="tabular"
              value={strength}
              placeholder="未设置"
              aria-invalid={!strengthValid}
              onChange={(event) => setStrength(event.target.value)}
            />
          </Field>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-caption font-medium text-ink-2">插入方式</span>
            <Segmented<LoraAutoInsert>
              block
              label="插入方式"
              value={mode}
              onChange={setMode}
              options={AUTO_ORDER.map((item) => ({ value: item, label: AUTO_INSERT_LABELS[item] }))}
            />
          </div>
        </div>
        <Field label="备注">
          <Textarea value={notes} rows={2} maxLength={2000} onChange={(event) => setNotes(event.target.value)} className="resize-none" />
        </Field>
      </div>
    </Modal>
  )
}
