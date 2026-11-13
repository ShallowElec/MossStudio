import { ImagePlus, Plus, Trash2, UserRound, X } from 'lucide-react'
import { useState } from 'react'
import { Ipc } from '@shared/channels'
import { emptyCharacter, newId, type MangaCharacter, type MangaImage, type MangaSeries } from '@shared/manga/model'
import { call } from '../../lib/api'
import { cloverUrl } from '../../lib/clover'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  Group,
  IconButton,
  Input,
  Row,
  Section,
  Switch,
  Textarea,
  useToast,
} from '../../components/ui'
import { AdapterEditor } from './parts'
import type { SeriesUpdate } from './useSeries'

const MAX_REFERENCES = 8

/** 人物: one card per character, with what never changes (appearance, LoRA, references) and the outfits they switch between. */
export function CharactersTab({ series, update }: { series: MangaSeries; update: SeriesUpdate }): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(series.characters[0]?.id ?? null)
  const selected = series.characters.find((character) => character.id === selectedId) ?? series.characters[0] ?? null

  const add = (): void => {
    const character = emptyCharacter(newId('char'), `人物 ${series.characters.length + 1}`)
    update((current) => ({ ...current, characters: [...current.characters, character] }))
    setSelectedId(character.id)
  }

  const change = (id: string, patch: (character: MangaCharacter) => MangaCharacter): void =>
    update((current) => ({ ...current, characters: current.characters.map((item) => (item.id === id ? patch(item) : item)) }))

  const remove = (id: string): void => {
    update((current) => ({
      ...current,
      characters: current.characters.filter((item) => item.id !== id),
      // Panels and lines that used the character lose it; the rest of the panel stays.
      chapters: current.chapters.map((chapter) => ({
        ...chapter,
        pages: chapter.pages.map((page) => ({
          ...page,
          panels: page.panels.map((panel) => ({
            ...panel,
            cast: panel.cast.filter((item) => item.characterId !== id),
            dialogue: panel.dialogue.map((line) => (line.speakerId === id ? { ...line, speakerId: undefined } : line)),
          })),
        })),
      })),
    }))
    setSelectedId(null)
  }

  if (!series.characters.length) {
    return (
      <EmptyState
        size="section"
        icon={<UserRound className="size-8" strokeWidth={1.6} />}
        title="还没有人物卡"
        description="给每个角色建一张卡：外貌、服装、参考图和 LoRA。分镜和出图时会自动带上，让角色每一格都长得一样。"
        action={
          <Button tone="primary" onClick={add}>
            <Plus className="size-4" strokeWidth={1.6} /> 添加人物
          </Button>
        }
      />
    )
  }

  return (
    <div className="flex min-h-0 gap-6">
      <div className="flex w-56 shrink-0 flex-col gap-2">
        <Group>
          {series.characters.map((character) => (
            <Row
              key={character.id}
              title={character.name}
              description={character.role || undefined}
              selected={character.id === selected?.id}
              onClick={() => setSelectedId(character.id)}
              leading={
                character.references[0] ? (
                  <img src={cloverUrl(character.references[0].path)} alt="" className="size-8 rounded-md object-cover" />
                ) : (
                  <UserRound className="size-4 text-ink-2" strokeWidth={1.6} />
                )
              }
            />
          ))}
        </Group>
        <Button onClick={add}>
          <Plus className="size-4" strokeWidth={1.6} /> 添加人物
        </Button>
      </div>
      {selected ? (
        <CharacterEditor
          key={selected.id}
          series={series}
          character={selected}
          onChange={(patch) => change(selected.id, patch)}
          onRemove={() => remove(selected.id)}
        />
      ) : null}
    </div>
  )
}

function CharacterEditor({
  series,
  character,
  onChange,
  onRemove,
}: {
  series: MangaSeries
  character: MangaCharacter
  onChange: (patch: (character: MangaCharacter) => MangaCharacter) => void
  onRemove: () => void
}): React.JSX.Element {
  const toast = useToast()
  const [importing, setImporting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const set = (patch: Partial<MangaCharacter>): void => onChange((current) => ({ ...current, ...patch }))

  const addReferences = async (): Promise<void> => {
    const paths = await call<string[]>(Ipc.pickImages, { title: `选择${character.name}的参考图` }).catch(() => [])
    if (!paths.length) return
    setImporting(true)
    const added: MangaImage[] = []
    for (const path of paths.slice(0, MAX_REFERENCES - character.references.length)) {
      try {
        added.push(await call<MangaImage>(Ipc.studioImportImage, { projectId: series.projectId, path }))
      } catch (error) {
        toast.push(error instanceof Error ? error.message : String(error), 'error')
      }
    }
    setImporting(false)
    if (added.length) onChange((current) => ({ ...current, references: [...current.references, ...added].slice(0, MAX_REFERENCES) }))
    if (paths.length > MAX_REFERENCES - character.references.length) toast.push(`每个人物最多 ${MAX_REFERENCES} 张参考图`, 'info')
  }

  return (
    <div className="flex min-w-0 max-w-[720px] flex-1 flex-col gap-8" aria-label={`人物卡：${character.name}`} role="region">
      <Section
        title="基本"
        actions={
          <Button tone="ghost-danger" size="xs" onClick={() => setConfirming(true)}>
            <Trash2 className="size-3.5" strokeWidth={1.6} /> 删除人物
          </Button>
        }
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="名字">
            <Input value={character.name} maxLength={60} onChange={(event) => set({ name: event.target.value })} />
          </Field>
          <Field label="身份">
            <Input value={character.role} placeholder="主角、搭档、反派…" onChange={(event) => set({ role: event.target.value })} />
          </Field>
        </div>
        <Field label="外貌" hint="不会变的样子：脸、发型、身材、标志。每一格都会带上。">
          <Textarea rows={3} value={character.appearance} onChange={(event) => set({ appearance: event.target.value })} />
        </Field>
        <Field label="性格" hint="只告诉语言模型，用来写分镜和台词。">
          <Textarea rows={2} value={character.personality} onChange={(event) => set({ personality: event.target.value })} />
        </Field>
      </Section>

      <Section
        title="参考图"
        description="第一张会放进描述里交给引擎，让脸、发型和服装每一格都更一致（需要支持人物参考图的引擎）。用只有人物头肩的图效果最好；整张场景图会让画面照搬它的场景。"
      >
        <div className="flex flex-wrap gap-2">
          {character.references.map((image, index) => (
            <div key={image.path} className="group relative size-24 overflow-hidden rounded-lg bg-panel">
              <img src={cloverUrl(image.path)} alt={`参考图 ${index + 1}`} className="size-full object-cover" />
              <IconButton
                label={`移除参考图 ${index + 1}`}
                className="absolute right-1 top-1 size-6 bg-raised"
                onClick={() => set({ references: character.references.filter((item) => item.path !== image.path) })}
              >
                <X className="size-3.5" strokeWidth={1.6} />
              </IconButton>
            </div>
          ))}
          {character.references.length < MAX_REFERENCES ? (
            <Button className="size-24 flex-col" disabled={importing} onClick={() => void addReferences()}>
              <ImagePlus className="size-4" strokeWidth={1.6} />
              {importing ? '正在添加…' : '添加参考图'}
            </Button>
          ) : null}
        </div>
      </Section>

      <Section title="服装" description="同一个人物在不同章节可以换装。每一格可以单独选，不选就用默认的。">
        {character.outfits.map((outfit) => (
          <div key={outfit.id} className="flex items-end gap-2 rounded-lg bg-panel p-3">
            <Field label="服装名" className="w-36">
              <Input
                value={outfit.name}
                onChange={(event) =>
                  set({ outfits: character.outfits.map((item) => (item.id === outfit.id ? { ...item, name: event.target.value } : item)) })
                }
              />
            </Field>
            <Field label="样子" className="flex-1">
              <Input
                value={outfit.prompt}
                onChange={(event) =>
                  set({
                    outfits: character.outfits.map((item) => (item.id === outfit.id ? { ...item, prompt: event.target.value } : item)),
                  })
                }
              />
            </Field>
            <label className="flex h-[34px] items-center gap-2 text-caption text-ink-2">
              默认
              <Switch
                aria-label={`${outfit.name || '这套服装'}设为默认`}
                checked={character.defaultOutfitId === outfit.id}
                onCheckedChange={(on) => set({ defaultOutfitId: on ? outfit.id : undefined })}
              />
            </label>
            <IconButton
              label={`移除服装 ${outfit.name}`}
              onClick={() =>
                set({
                  outfits: character.outfits.filter((item) => item.id !== outfit.id),
                  defaultOutfitId: character.defaultOutfitId === outfit.id ? undefined : character.defaultOutfitId,
                })
              }
            >
              <X className="size-4" strokeWidth={1.6} />
            </IconButton>
          </div>
        ))}
        <div>
          <Button
            onClick={() => {
              const outfit = { id: newId('outfit'), name: `服装 ${character.outfits.length + 1}`, prompt: '' }
              set({ outfits: [...character.outfits, outfit], defaultOutfitId: character.defaultOutfitId ?? outfit.id })
            }}
          >
            <Plus className="size-4" strokeWidth={1.6} /> 添加服装
          </Button>
        </div>
      </Section>

      <Section title="人物 LoRA" description="用这个人物训练的 LoRA。画到这个人物的格子才会用上。">
        <Field label="触发词" hint="LoRA 训练时用的词，会放在外貌前面。">
          <Input value={character.triggerWords} onChange={(event) => set({ triggerWords: event.target.value })} />
        </Field>
        <AdapterEditor adapters={character.adapters} onChange={(adapters) => set({ adapters })} />
      </Section>

      <ConfirmDialog
        open={confirming}
        title={`删除「${character.name}」？`}
        description="用到这个人物的格子会去掉他，台词改为没有说话人。"
        confirmLabel="删除"
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          onRemove()
        }}
      />
    </div>
  )
}
