import { Copy } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { Ipc } from '@shared/channels'
import { TRAINING_ALGOS, TRAINING_VRAM, trainingRecipeSchema, type TrainingProject, type TrainingRecipe } from '@shared/training'
import type { ManagedHost } from '@shared/types'
import { call } from '../../lib/api'
import { FieldLabel, IconButton, Input, Select, Textarea, cn, useCopyText, useToast } from '../../components/ui'
import { ALGO_LABEL } from './trainingModel'
import { errorText } from './useTraining'

const SAMPLE_EVERY = [0, 250, 500, 1000]

/** A text box for one recipe value: kept as typed, saved on blur once it parses. */
function RecipeInput({
  label,
  value,
  parse,
  onCommit,
  placeholder,
  mono = true,
}: {
  label: string
  value: string
  parse: (text: string) => { ok: true } | { ok: false; error: string }
  onCommit: (text: string) => void
  placeholder?: string
  mono?: boolean
}): React.JSX.Element {
  const id = useId()
  const [text, setText] = useState(value)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setText(value), [value])

  function commit(): void {
    if (text === value) return setError(null)
    const result = parse(text)
    if (!result.ok) return setError(result.error)
    setError(null)
    onCommit(text)
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={text}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
        }}
        className={cn('h-[30px]', mono && 'font-mono text-caption')}
      />
      {error ? (
        <span role="alert" className="text-caption text-danger">
          {error}
        </span>
      ) : null}
    </div>
  )
}

function checked<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } } },
  value: T,
) {
  const result = schema.safeParse(value)
  return result.success ? ({ ok: true } as const) : ({ ok: false, error: result.error?.issues[0]?.message ?? '这个值不行' } as const)
}

const integer = (text: string): number | null => (/^\s*\d+\s*$/.test(text) ? Number(text) : null)

function intField(
  key: 'steps' | 'batch' | 'resolution',
  label: string,
  recipe: TrainingRecipe,
  onChange: (patch: Partial<TrainingRecipe>) => void,
) {
  return (
    <RecipeInput
      label={label}
      value={String(recipe[key])}
      parse={(text) => {
        const value = integer(text)
        return value === null ? { ok: false, error: '请输入整数' } : checked(trainingRecipeSchema.shape[key], value)
      }}
      onCommit={(text) => onChange({ [key]: Number(text) })}
    />
  )
}

function optionalNumberField(
  key: 'dim' | 'alpha',
  label: string,
  recipe: TrainingRecipe,
  onChange: (patch: Partial<TrainingRecipe>) => void,
) {
  return (
    <RecipeInput
      label={label}
      value={recipe[key] === null ? '' : String(recipe[key])}
      placeholder="自动"
      parse={(text) => {
        if (!text.trim()) return { ok: true }
        const value = Number(text)
        return Number.isFinite(value)
          ? checked(trainingRecipeSchema.shape[key], key === 'dim' ? Math.trunc(value) : value)
          : { ok: false, error: '请输入数字' }
      }}
      onCommit={(text) => onChange({ [key]: text.trim() ? (key === 'dim' ? Math.trunc(Number(text)) : Number(text)) : null })}
    />
  )
}

/**
 * Every recipe knob, under 高级: what the trainer reads, the sample settings,
 * the location when there is a choice, and the commands to copy.
 */
export function RecipeFields({
  project,
  baseModel,
  sshHosts,
  onRecipe,
  onHost,
}: {
  project: TrainingProject
  baseModel: string
  sshHosts: ManagedHost[]
  onRecipe: (patch: Partial<TrainingRecipe>) => void
  onHost: (hostId: string) => void
}): React.JSX.Element {
  const toast = useToast()
  const copy = useCopyText()
  const recipe = project.recipe
  const promptsId = useId()
  const overridesId = useId()
  const [prompts, setPrompts] = useState(recipe.samplePrompts.join('\n'))
  const [promptsError, setPromptsError] = useState<string | null>(null)
  const [overrides, setOverrides] = useState(recipe.overrides)
  useEffect(() => setPrompts(recipe.samplePrompts.join('\n')), [recipe.samplePrompts])
  useEffect(() => setOverrides(recipe.overrides), [recipe.overrides])

  async function copyCommand(): Promise<void> {
    try {
      await copy(await call<string>(Ipc.trainingCommand, { id: project.id }), '已复制训练命令')
    } catch (error) {
      toast.push(`没能读取训练命令：${errorText(error)}`, 'error')
    }
  }

  function commitPrompts(): void {
    const list = prompts
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const result = checked(trainingRecipeSchema.shape.samplePrompts, list)
    if (!result.ok) return setPromptsError(list.length ? result.error : '至少写一条样图描述')
    setPromptsError(null)
    if (list.join('\n') !== recipe.samplePrompts.join('\n')) onRecipe({ samplePrompts: list })
  }

  return (
    <div className="flex flex-col gap-3 pt-1" data-recipe-fields>
      <div className="grid grid-cols-2 gap-x-2.5 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <FieldLabel>底模</FieldLabel>
          <Input value={baseModel} readOnly aria-label="底模" className="h-[30px] text-ui" />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <FieldLabel>算法</FieldLabel>
          <Select
            aria-label="算法"
            className="h-[30px]"
            value={recipe.algo}
            options={TRAINING_ALGOS.map((algo) => ({ value: algo, label: ALGO_LABEL[algo] }))}
            onValueChange={(algo) => onRecipe({ algo: algo as TrainingRecipe['algo'] })}
          />
        </div>
        {optionalNumberField('dim', '维度', recipe, onRecipe)}
        {optionalNumberField('alpha', 'Alpha', recipe, onRecipe)}
        <RecipeInput
          label="学习率"
          value={recipe.lr ?? ''}
          placeholder="自动"
          parse={(text) => (text.trim() ? checked(trainingRecipeSchema.shape.lr, text.trim()) : { ok: true })}
          onCommit={(text) => onRecipe({ lr: text.trim() || null })}
        />
        {intField('steps', '步数', recipe, onRecipe)}
        {intField('batch', '梯度累积', recipe, onRecipe)}
        {intField('resolution', '分辨率', recipe, onRecipe)}
        <div className="flex min-w-0 flex-col gap-1">
          <FieldLabel>显存</FieldLabel>
          <Select
            aria-label="显存"
            className="h-[30px]"
            value={recipe.vram}
            options={TRAINING_VRAM.map((vram) => ({ value: vram, label: vram === 'auto' ? '自动' : `${vram} GB 档` }))}
            onValueChange={(vram) => onRecipe({ vram: vram as TrainingRecipe['vram'] })}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <FieldLabel>样图</FieldLabel>
          <Select
            aria-label="样图"
            className="h-[30px]"
            value={String(recipe.sampleEvery)}
            options={[...new Set([...SAMPLE_EVERY, recipe.sampleEvery])]
              .sort((a, b) => a - b)
              .map((every) => ({ value: String(every), label: every ? `每 ${every} 步` : '不画样图' }))}
            onValueChange={(every) => onRecipe({ sampleEvery: Number(every) })}
          />
        </div>
        {sshHosts.length ? (
          <div className="col-span-2 flex min-w-0 flex-col gap-1">
            <FieldLabel>位置</FieldLabel>
            <Select
              aria-label="位置"
              className="h-[30px]"
              value={project.hostId}
              options={[{ value: 'local', label: '本机' }, ...sshHosts.map((host) => ({ value: host.id, label: host.name }))]}
              onValueChange={onHost}
            />
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <FieldLabel htmlFor={promptsId}>样图描述</FieldLabel>
        <Textarea
          id={promptsId}
          rows={3}
          value={prompts}
          aria-invalid={promptsError ? true : undefined}
          onChange={(event) => setPrompts(event.target.value)}
          onBlur={commitPrompts}
          className="min-h-[76px] text-ui"
        />
        {promptsError ? (
          <span role="alert" className="text-caption text-danger">
            {promptsError}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <FieldLabel
          htmlFor={overridesId}
          value={
            <IconButton label="复制训练命令" className="-my-1 size-6" onClick={() => void copyCommand()}>
              <Copy className="size-3.5" strokeWidth={1.6} />
            </IconButton>
          }
        >
          额外参数
        </FieldLabel>
        <Textarea
          id={overridesId}
          rows={2}
          value={overrides}
          placeholder="KEY=VALUE"
          spellCheck={false}
          onChange={(event) => setOverrides(event.target.value)}
          onBlur={() => {
            if (overrides !== recipe.overrides) onRecipe({ overrides })
          }}
          className="min-h-[52px] font-mono text-caption"
        />
      </div>
    </div>
  )
}
