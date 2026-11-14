import type { MangaAdapter, MangaCharacter, MangaPanel, MangaSeries, Shot } from './model'

/**
 * How one panel becomes a description, LoRA list and reference pictures for
 * the engine. The series 画风 comes first so every panel shares it; then the
 * shot, the scene, and one line per character in the panel (trigger words,
 * fixed appearance, the outfit worn here, expression and pose). Pure.
 */

export const SHOT_LABEL: Record<Shot, string> = {
  wide: '远景',
  full: '全景',
  medium: '中景',
  close: '近景',
  extreme: '特写',
}

const SHOT_PROMPT: Record<Shot, string> = {
  wide: '远景，人物很小，交代环境',
  full: '全景，人物全身入镜',
  medium: '中景，人物膝盖以上',
  close: '近景，人物胸部以上',
  extreme: '特写，脸部或细节占满画面',
}

/**
 * How large each character picture goes into the prompt (MossInfer `vision_references.max_pixels`, ~1 token per
 * 32×32 pixels). A picture carries its framing along with the face: at the engine's default (100000) a wide shot
 * turns into a portrait. Fewer tokens keep the face and leave the framing to the description. The engine's
 * `weight` only fades the picture toward gray and barely changes a black and white portrait, so it is not used.
 * Measured in docs/records/2026-11-13-manga-consistency.md.
 */
export const REFERENCE_PIXELS: Record<Shot, number> = {
  wide: 25_000,
  full: 25_000,
  medium: 50_000,
  close: 50_000,
  extreme: 100_000,
}

/** Mirrors the engine request: more reference pictures than this are not sent. */
export const MANGA_MAX_REFERENCES = 4
const MAX_ADAPTERS = 16

export interface CompiledPanel {
  prompt: string
  negative: string
  adapters: MangaAdapter[]
  /** One reference picture per character, in cast order. */
  references: string[]
  /** How large each reference goes into the prompt, by the panel's shot (REFERENCE_PIXELS). */
  referencePixels: number
  /** What stops this panel from being drawn, in plain words. */
  problems: string[]
}

function joinParts(parts: Array<string | undefined>, separator = '，'): string {
  return parts
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(separator)
}

export function castLine(character: MangaCharacter, cast: MangaPanel['cast'][number]): string {
  const outfit = character.outfits.find((item) => item.id === (cast.outfitId ?? character.defaultOutfitId))
  const look = joinParts([character.triggerWords, character.appearance, outfit?.prompt, cast.expression, cast.pose])
  return look ? `${character.name}：${look}` : character.name
}

export function compilePanelPrompt(series: Pick<MangaSeries, 'style' | 'characters'>, panel: MangaPanel): CompiledPanel {
  const problems: string[] = []
  const characters = new Map(series.characters.map((character) => [character.id, character]))
  const cast = panel.cast.flatMap((item) => {
    const character = characters.get(item.characterId)
    if (!character) {
      problems.push('这一格用了一个已经删除的人物，请重新选择')
      return []
    }
    return [{ character, item }]
  })

  const adapters: MangaAdapter[] = []
  const seen = new Set<string>()
  for (const adapter of [...series.style.adapters, ...cast.flatMap(({ character }) => character.adapters)]) {
    if (seen.has(adapter.id) || adapters.length >= MAX_ADAPTERS) continue
    seen.add(adapter.id)
    adapters.push(adapter)
  }

  const references = cast
    .map(({ character }) => character.references[0]?.path)
    .filter((path): path is string => Boolean(path))
    .slice(0, MANGA_MAX_REFERENCES)

  const override = panel.promptOverride?.trim()
  if (!override && !panel.scene.trim()) problems.push('这一格还没有画面描述')
  const prompt = override
    ? override
    : joinParts(
        [
          series.style.prompt,
          SHOT_PROMPT[panel.shot],
          panel.scene,
          ...cast.map(({ character, item }) => castLine(character, item)),
          panel.note ? `修改要求：${panel.note}` : undefined,
        ],
        '\n',
      )

  return {
    prompt,
    // Lettering is added afterwards, so the picture itself should carry none. The description never mentions
    // balloons, not even where to leave room for them: any word about them makes the model draw its own.
    negative: joinParts([
      series.style.negative,
      series.style.monochrome && !series.style.negative.includes('彩色') ? '彩色' : undefined,
      '文字，对白框，水印',
    ]),
    adapters,
    references,
    referencePixels: REFERENCE_PIXELS[panel.shot],
    problems,
  }
}
