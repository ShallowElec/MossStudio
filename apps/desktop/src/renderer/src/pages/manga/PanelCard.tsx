import { Check, MessageSquarePlus, Play, RotateCcw, Square, UserPlus, X } from 'lucide-react'
import { useState } from 'react'
import { BALLOON_KIND_LABEL, BALLOON_SPOTS, defaultBalloonPlaces, nearestSpot } from '@shared/manga/balloons'
import { BALLOON_KINDS, SHOTS, newId, panelPicture, type MangaPanel, type MangaSeries } from '@shared/manga/model'
import { SHOT_LABEL, compilePanelPrompt } from '@shared/manga/prompt'
import { approve, reject } from '@shared/manga/queue'
import { Ipc } from '@shared/channels'
import { call } from '../../lib/api'
import { cloverUrl } from '../../lib/clover'
import { Notice } from '../../components/common/Notice'
import { PromptBlock } from '../../components/common/PromptBlock'
import { Advanced, Button, Card, Field, IconButton, Input, Pill, ProgressBar, Select, Textarea, cn } from '../../components/ui'
import { PANEL_STATE_LABEL, PANEL_STATE_TONE, panelErrorText } from './logic'

/**
 * One panel (格): its picture and takes, what it shows, who is in it and what
 * they say, and the step it is at: 生成 → 审核 (通过 or 重画) → 已通过.
 */
export function PanelCard({
  series,
  panel,
  label,
  onChange,
  onDraw,
}: {
  series: MangaSeries
  panel: MangaPanel
  /** 第 2 格 */
  label: string
  onChange: (change: (panel: MangaPanel) => MangaPanel) => void
  /** Put this panel in the drawing queue. */
  onDraw: () => void
}): React.JSX.Element {
  const [note, setNote] = useState('')
  const [shown, setShown] = useState<number | null>(null)
  const picture = shown !== null && panel.takes[shown] ? panel.takes[shown] : panelPicture(panel)
  const shownIndex = picture ? panel.takes.indexOf(picture) : -1
  const characters = series.characters
  const set = (patch: Partial<MangaPanel>): void => onChange((current) => ({ ...current, ...patch }))
  const canDraw = Boolean(panel.scene.trim() || panel.promptOverride?.trim())

  return (
    <Card
      tone="panel"
      className="flex flex-col gap-3 p-3"
      role="group"
      aria-label={label}
      data-manga-panel={panel.id}
      data-state={panel.state}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui font-semibold text-ink-2">{label}</span>
        <Pill tone={PANEL_STATE_TONE[panel.state]}>{PANEL_STATE_LABEL[panel.state]}</Pill>
      </div>

      <div className="flex gap-3">
        <div className="flex w-40 shrink-0 flex-col gap-1.5">
          <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg bg-well">
            {picture ? (
              <img
                src={cloverUrl(picture.path)}
                alt={`${label}的画面`}
                className={cn('size-full object-contain', series.style.monochrome && 'grayscale')}
              />
            ) : (
              <span className="text-caption text-ink-2">{panel.state === 'running' ? '正在画…' : '还没有画面'}</span>
            )}
          </div>
          {panel.takes.length > 1 ? (
            <div className="flex flex-wrap gap-1" role="group" aria-label={`${label}的历次结果`}>
              {panel.takes.map((take, index) => (
                <button
                  key={`${take.jobId}-${take.seed}-${index}`}
                  type="button"
                  aria-label={`第 ${index + 1} 次结果`}
                  aria-pressed={index === shownIndex}
                  onClick={() => setShown(index)}
                  className={cn('size-8 overflow-hidden rounded-md bg-well', index === shownIndex && 'outline-2 outline-accent')}
                >
                  <img src={cloverUrl(take.path)} alt="" className={cn('size-full object-cover', series.style.monochrome && 'grayscale')} />
                </button>
              ))}
            </div>
          ) : null}
          {panel.state === 'running' ? <ProgressBar value={null} label={`${label}正在生成`} /> : null}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <div className="flex gap-2">
            <Field label="画面描述" className="flex-1">
              <Textarea rows={5} value={panel.scene} onChange={(event) => set({ scene: event.target.value })} />
            </Field>
            <Field label="镜头" className="w-24">
              <Select
                value={panel.shot}
                onValueChange={(shot) => set({ shot: shot as MangaPanel['shot'] })}
                options={SHOTS.map((shot) => ({ value: shot, label: SHOT_LABEL[shot] }))}
              />
            </Field>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {panel.cast.map((member, index) => {
          const character = characters.find((item) => item.id === member.characterId)
          const setMember = (patch: Partial<typeof member>): void =>
            set({ cast: panel.cast.map((item, at) => (at === index ? { ...item, ...patch } : item)) })
          return (
            <div key={`${member.characterId}-${index}`} className="flex items-center gap-1.5">
              <Select
                aria-label="人物"
                className="w-24"
                value={member.characterId}
                onValueChange={(characterId) => setMember({ characterId, outfitId: undefined })}
                options={[
                  ...(character ? [] : [{ value: member.characterId, label: '已删除' }]),
                  ...characters.map((item) => ({ value: item.id, label: item.name })),
                ]}
              />
              <Select
                aria-label={`${character?.name ?? '人物'}的服装`}
                className="w-28"
                value={member.outfitId ?? ''}
                onValueChange={(outfitId) => setMember({ outfitId: outfitId || undefined })}
                options={[
                  { value: '', label: '默认服装' },
                  ...(character?.outfits ?? []).map((outfit) => ({ value: outfit.id, label: outfit.name })),
                ]}
              />
              <Input
                aria-label={`${character?.name ?? '人物'}的表情`}
                placeholder="表情"
                className="min-w-0 flex-1"
                value={member.expression}
                onChange={(event) => setMember({ expression: event.target.value })}
              />
              <Input
                aria-label={`${character?.name ?? '人物'}的动作`}
                placeholder="动作"
                className="min-w-0 flex-1"
                value={member.pose}
                onChange={(event) => setMember({ pose: event.target.value })}
              />
              <IconButton
                label={`从这一格去掉${character?.name ?? '人物'}`}
                className="size-7"
                onClick={() => set({ cast: panel.cast.filter((_, at) => at !== index) })}
              >
                <X className="size-3.5" strokeWidth={1.6} />
              </IconButton>
            </div>
          )
        })}

        {panel.dialogue.map((line) => {
          const setLine = (patch: Partial<typeof line>): void =>
            set({ dialogue: panel.dialogue.map((item) => (item.id === line.id ? { ...item, ...patch } : item)) })
          return (
            <div key={line.id} className="flex items-center gap-1.5">
              <Select
                aria-label="对白类型"
                className="w-20"
                value={line.kind}
                onValueChange={(kind) =>
                  setLine({ kind: kind as typeof line.kind, ...(kind === 'narration' ? { speakerId: undefined } : {}) })
                }
                options={BALLOON_KINDS.map((kind) => ({ value: kind, label: BALLOON_KIND_LABEL[kind] }))}
              />
              {line.kind !== 'narration' ? (
                <Select
                  aria-label="说话人"
                  className="w-24"
                  value={line.speakerId ?? ''}
                  onValueChange={(speakerId) => setLine({ speakerId: speakerId || undefined })}
                  options={[{ value: '', label: '不写名字' }, ...characters.map((item) => ({ value: item.id, label: item.name }))]}
                />
              ) : null}
              <Input
                aria-label="台词"
                className="min-w-0 flex-1"
                value={line.text}
                onChange={(event) => setLine({ text: event.target.value })}
              />
              <Select
                aria-label="气泡位置"
                className="w-20"
                value={nearestSpot(line.x, line.y).value}
                onValueChange={(value) => {
                  const spot = BALLOON_SPOTS.find((item) => item.value === value)
                  if (spot) setLine({ x: spot.x, y: spot.y })
                }}
                options={BALLOON_SPOTS.map((spot) => ({ value: spot.value, label: spot.label }))}
              />
              <IconButton
                label="删除这句"
                className="size-7"
                onClick={() => set({ dialogue: panel.dialogue.filter((item) => item.id !== line.id) })}
              >
                <X className="size-3.5" strokeWidth={1.6} />
              </IconButton>
            </div>
          )
        })}

        <div className="flex flex-wrap gap-1.5">
          {characters.length ? (
            <Button
              size="xs"
              tone="ghost"
              onClick={() => {
                const next = characters.find((item) => !panel.cast.some((member) => member.characterId === item.id)) ?? characters[0]!
                set({ cast: [...panel.cast, { characterId: next.id, expression: '', pose: '' }] })
              }}
            >
              <UserPlus className="size-3.5" strokeWidth={1.6} /> 加人物
            </Button>
          ) : null}
          <Button
            size="xs"
            tone="ghost"
            onClick={() => {
              const spot = defaultBalloonPlaces(panel.dialogue.length + 1, series.readingDirection).at(-1)!
              set({ dialogue: [...panel.dialogue, { id: newId('line'), kind: 'speech', text: '', x: spot.x, y: spot.y }] })
            }}
          >
            <MessageSquarePlus className="size-3.5" strokeWidth={1.6} /> 加对白
          </Button>
        </div>
      </div>

      {panel.error && panel.state !== 'review' && panel.state !== 'approved' ? (
        <Notice tone={panel.state === 'failed' ? 'danger' : 'warn'}>{panelErrorText(panel)}</Notice>
      ) : null}

      <PanelActions
        panel={panel}
        label={label}
        shownIndex={shownIndex}
        canDraw={canDraw}
        note={note}
        setNote={setNote}
        onChange={onChange}
        onDraw={onDraw}
      />

      <Advanced title="自己写描述">
        <div className="flex flex-col gap-2">
          <Field label="替换描述" hint="写了就只用这里的文字，不再拼画风、镜头和人物卡。">
            <Textarea
              rows={3}
              value={panel.promptOverride ?? ''}
              onChange={(event) => set({ promptOverride: event.target.value || undefined })}
            />
          </Field>
          <PromptBlock title="交给引擎的描述" text={compilePanelPrompt(series, panel).prompt} />
        </div>
      </Advanced>
    </Card>
  )
}

function PanelActions({
  panel,
  label,
  shownIndex,
  canDraw,
  note,
  setNote,
  onChange,
  onDraw,
}: {
  panel: MangaPanel
  label: string
  shownIndex: number
  canDraw: boolean
  note: string
  setNote: (note: string) => void
  onChange: (change: (panel: MangaPanel) => MangaPanel) => void
  onDraw: () => void
}): React.JSX.Element | null {
  if (panel.state === 'queued') {
    return (
      <div className="flex items-center justify-end gap-2">
        <Button
          size="xs"
          tone="ghost"
          onClick={() => onChange((current) => ({ ...current, state: current.takes.length ? 'review' : 'draft' }))}
        >
          取消排队
        </Button>
      </div>
    )
  }
  if (panel.state === 'running') {
    const stop = (): void => {
      const jobId = panel.jobId
      // The job's 已取消 event moves the panel back; a job that is gone is let go here.
      if (jobId)
        void call(Ipc.jobCancel, { id: jobId }).catch(() => onChange((current) => ({ ...current, jobId: undefined, state: 'draft' })))
      else onChange((current) => ({ ...current, state: 'draft' }))
    }
    return (
      <div className="flex items-center justify-end gap-2">
        <Button size="xs" tone="ghost" onClick={stop}>
          <Square className="size-3.5" strokeWidth={1.6} /> 停止
        </Button>
      </div>
    )
  }
  if (panel.state === 'review') {
    return (
      <div className="flex items-center gap-2">
        <Input
          aria-label={`${label}要改什么`}
          placeholder="要改什么（重画时告诉引擎）"
          className="min-w-0 flex-1"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <Button
          size="xs"
          onClick={() => {
            onChange((current) => reject(current, note))
            setNote('')
          }}
        >
          <RotateCcw className="size-3.5" strokeWidth={1.6} /> 重画
        </Button>
        <Button size="xs" onClick={() => onChange((current) => approve(current, Math.max(0, shownIndex)))}>
          <Check className="size-3.5" strokeWidth={1.6} /> 通过
        </Button>
      </div>
    )
  }
  if (panel.state === 'approved') {
    return (
      <div className="flex items-center justify-end gap-2">
        {shownIndex >= 0 && shownIndex !== panel.chosen ? (
          <Button size="xs" onClick={() => onChange((current) => approve(current, shownIndex))}>
            改用这张
          </Button>
        ) : null}
        <Button size="xs" tone="ghost" onClick={onDraw}>
          <RotateCcw className="size-3.5" strokeWidth={1.6} /> 重画
        </Button>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-end gap-2">
      <Button size="xs" disabled={!canDraw} title={canDraw ? undefined : '先写画面描述'} onClick={onDraw}>
        <Play className="size-3.5" strokeWidth={1.6} /> {panel.state === 'failed' ? '再试一次' : '生成'}
      </Button>
    </div>
  )
}
