import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn, IconButton, Input, Select, useToast } from '../../../components/ui'
import type { AgentModelCatalog, AgentModelOption, CollabClient } from './collabClient'

const CUSTOM = '__custom__'
/** The value the current model keeps while the Agent's list does not contain it. */
const UNSET = '__current__'

export interface ModelState {
  model?: string
  provider?: string
  reasoningEffort?: string
}

export interface ModelChoice {
  /** Distinct across providers, so two of them offering the same id can both be picked: the leading position makes it unique, `provider/id` only makes it readable. */
  value: string
  model: AgentModelOption
  /** What the option reads: the model's name without the provider heading's own name. */
  label: string
}

export interface ModelGroup {
  /** The Agent's provider id; absent for the models it lists without one. */
  provider?: string
  choices: ModelChoice[]
}

/**
 * The Agent's models grouped by provider, in the order it lists them: a long
 * flat list is what made the old picker unreadable. Two providers may offer the
 * same model id, so every entry gets a value of its own instead of the id — the
 * old `value={item.id}` silently switched to whichever provider came first.
 * A label that only repeats its provider (`x · provider`) drops that tail,
 * because the group heading already says it.
 */
export function modelGroups(models: readonly AgentModelOption[]): ModelGroup[] {
  const groups: ModelGroup[] = []
  const byProvider = new Map<string, ModelGroup>()
  const plain: ModelGroup = { choices: [] }
  let position = 0
  for (const model of models) {
    const id = model.id?.trim()
    if (!id) continue
    const provider = model.provider?.trim() || undefined
    const named = model.label?.trim() || id
    const label = provider && named.endsWith(` · ${provider}`) ? named.slice(0, -provider.length - 3).trim() || id : named
    const value = `${position++}:${provider ? `${provider}/` : ''}${id}`
    const choice: ModelChoice = { value, model, label }
    if (!provider) {
      plain.choices.push(choice)
      continue
    }
    let group = byProvider.get(provider)
    if (!group) {
      group = { provider, choices: [] }
      byProvider.set(provider, group)
      groups.push(group)
    }
    group.choices.push(choice)
  }
  return plain.choices.length ? [plain, ...groups] : groups
}

/** The session's model and reasoning level; a typed name when the Agent gives no list. */
export function ModelPicker({
  client,
  backendId,
  sessionId,
  fallbackModel,
  onModelChange,
}: {
  client: CollabClient
  backendId: string
  sessionId: string
  /** What the session list says, shown until the Agent answers. */
  fallbackModel?: string
  onModelChange?: (state: ModelState) => void
}): React.JSX.Element {
  const [catalog, setCatalog] = useState<AgentModelCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const toast = useToast()
  const generation = useRef(0)

  const load = useCallback(async () => {
    const version = ++generation.current
    setLoading(true)
    const next = await client.listModels(backendId, sessionId)
    if (generation.current !== version) return
    setCatalog(next)
    setLoading(false)
  }, [client, backendId, sessionId])

  useEffect(() => {
    // The ref object itself, held for the cleanup: a reply still on its way is dropped.
    const gen = generation
    void load()
    return () => {
      gen.current++
    }
  }, [load])

  const current = catalog?.currentModel ?? fallbackModel
  const effort = catalog?.currentReasoningEffort
  useEffect(() => {
    onModelChange?.({ model: current, provider: catalog?.currentProvider, reasoningEffort: effort })
  }, [current, effort, catalog?.currentProvider, onModelChange])

  async function apply(next: { model: string; provider?: string; reasoningEffort?: string }): Promise<void> {
    const model = next.model.trim()
    if (!model) return
    const previous = catalog
    setCatalog((value) => ({
      models: value?.models ?? [],
      reasoningEfforts: value?.reasoningEfforts ?? [],
      currentModel: model,
      ...((next.provider ?? value?.currentProvider) ? { currentProvider: next.provider ?? value?.currentProvider } : {}),
      ...((next.reasoningEffort ?? value?.currentReasoningEffort)
        ? { currentReasoningEffort: next.reasoningEffort ?? value?.currentReasoningEffort }
        : {}),
    }))
    try {
      const ok = await client.setModel({ backendId, sessionId, ...next, model })
      if (!ok) {
        setCatalog(previous)
        toast.push('这个 Agent 暂时不能在这里切换模型', 'info')
        return
      }
      toast.push(`已切换到 ${model}${next.reasoningEffort ? ` · ${next.reasoningEffort}` : ''}`, 'info')
    } catch (error) {
      setCatalog(previous)
      toast.push(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  const models = useMemo(() => catalog?.models ?? [], [catalog?.models])
  const groups = useMemo(() => modelGroups(models), [models])
  const choices = useMemo(() => groups.flatMap((group) => group.choices), [groups])
  // The same id may come from several providers; the session's own provider decides which is meant.
  const chosen =
    choices.find((choice) => choice.model.id === current && choice.model.provider === catalog?.currentProvider) ??
    choices.find((choice) => choice.model.id === current)
  const efforts = catalog?.reasoningEfforts ?? []

  return (
    <div className="flex min-w-0 items-center gap-1" data-model-picker>
      <span className="shrink-0 text-micro text-ink-2">模型</span>
      {typing || !models.length ? (
        <form
          className="flex min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            setTyping(false)
            void apply({ model: draft })
          }}
        >
          <Input
            aria-label="会话模型"
            value={typing ? draft : (current ?? '')}
            placeholder={loading ? '正在读取…' : '输入模型名，回车切换'}
            spellCheck={false}
            maxLength={200}
            onFocus={() => {
              if (!typing) setDraft(current ?? '')
              setTyping(true)
            }}
            onBlur={() => setTyping(false)}
            onChange={(event) => setDraft(event.target.value)}
            className="h-6 min-w-0 flex-1 text-micro"
          />
        </form>
      ) : (
        <Select
          aria-label="会话模型"
          value={chosen?.value ?? (current ? UNSET : '')}
          title={chosen ? `${chosen.label}${chosen.model.provider ? ` · ${chosen.model.provider}` : ''}` : undefined}
          onValueChange={(value) => {
            if (value === CUSTOM) {
              setDraft(current ?? '')
              setTyping(true)
              return
            }
            const choice = choices.find((item) => item.value === value)
            if (!choice) return
            void apply({ model: choice.model.id, ...(choice.model.provider ? { provider: choice.model.provider } : {}) })
          }}
          className="h-6 min-w-0 flex-1 text-micro"
        >
          {!current ? <option value="">选择模型</option> : null}
          {current && !chosen ? (
            <optgroup label="当前">
              <option value={UNSET}>{current}</option>
            </optgroup>
          ) : null}
          {groups.map((group) =>
            group.provider ? (
              <optgroup key={group.provider} label={group.provider}>
                {group.choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </optgroup>
            ) : (
              group.choices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))
            ),
          )}
          <option value={CUSTOM}>手动输入…</option>
        </Select>
      )}
      {efforts.length ? (
        <Select
          aria-label="推理档位"
          value={effort ?? ''}
          onValueChange={(value) => {
            if (current && value) void apply({ model: current, reasoningEffort: value })
          }}
          className="h-6 w-auto max-w-[6rem] shrink-0 text-micro"
        >
          {!effort ? <option value="">推理</option> : null}
          {efforts.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Select>
      ) : null}
      <IconButton label="刷新模型列表" className="size-6" disabled={loading} onClick={() => void load()}>
        <RefreshCw className={cn('size-3', loading && 'animate-spin')} strokeWidth={1.6} />
      </IconButton>
    </div>
  )
}
