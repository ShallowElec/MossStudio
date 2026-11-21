import type { CanvasAdapter, ProjectCanvas, ProjectLayer } from '@shared/types'
import { compileLayout, type LayoutDraft, type LayoutItemDraft } from '../../lib/layout'

/**
 * What prompt compilation needs from a LoRA's remembered profile. Kept here,
 * not imported from the IPC client, so main-process tests that reach this file
 * through `readiness` never pull in `window`.
 */
export interface LoraTriggerProfile {
  triggers: readonly string[]
  autoInsert?: 'manual' | 'prefix' | 'suffix'
}

export type LoraTriggerProfiles = Readonly<Record<string, LoraTriggerProfile>>

function profileFor(profiles: LoraTriggerProfiles, adapter: Pick<CanvasAdapter, 'id' | 'path'>): LoraTriggerProfile | undefined {
  return profiles[adapter.path ?? adapter.id] ?? profiles[adapter.id]
}

/**
 * "The layout is the prompt": what the engine receives is always compiled from
 * the canvas description plus its visible regions. There is no hand-written
 * prompt that silently wins over the layout, and no insert step.
 */

type PromptSource = Pick<ProjectCanvas, 'prompt' | 'summary' | 'layers'>

export function visibleLayers(layers: readonly ProjectLayer[]): ProjectLayer[] {
  return layers.filter((layer) => layer.visible !== false)
}

/**
 * The description of a canvas. New canvases keep it in both `prompt` and
 * `summary.caption`; older ones used `prompt` for plain runs and
 * `summary.caption` for region runs, so read the one that run actually used.
 */
export function canvasDescription(canvas: PromptSource): string {
  const prompt = canvas.prompt ?? ''
  const caption = canvas.summary?.caption ?? ''
  if (visibleLayers(canvas.layers).length > 0) return caption.trim() ? caption : prompt
  return prompt.trim() ? prompt : caption
}

/** Write the description to both places it is read from. */
export function withDescription<T extends PromptSource>(canvas: T, description: string): T {
  return { ...canvas, prompt: description, summary: { ...canvas.summary, caption: description } }
}

export function layerToItem(layer: ProjectLayer): LayoutItemDraft {
  return {
    id: layer.id,
    label: layer.kind,
    caption: layer.caption,
    text: layer.text,
    bbox: layer.bbox,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
  }
}

export function canvasToDraft(canvas: PromptSource & Pick<ProjectCanvas, 'width' | 'height'>): LayoutDraft {
  return {
    width: canvas.width,
    height: canvas.height,
    summary: {
      caption: canvasDescription(canvas),
      meta: canvas.summary?.meta ?? [],
      canvas: canvas.summary?.canvas ?? 'single',
    },
    items: canvas.layers.map(layerToItem),
  }
}

export interface CompiledPrompt {
  ok: boolean
  /** Exactly what is sent to the engine. */
  prompt: string
  /** Human-readable form for the read-only 查看最终提示词 view. */
  preview: string
  source: 'layout' | 'text'
  regions: number
  errors: string[]
}

export const EMPTY_PROMPT_ERROR = '先写一句描述'

type CompileSource = PromptSource & Pick<ProjectCanvas, 'width' | 'height'> & Partial<Pick<ProjectCanvas, 'adapters'>>

/**
 * The prompt the engine receives. `profiles` are the remembered LoRA profiles:
 * a LoRA set to 自动前置 / 自动后置 adds its trigger words for every adapter in
 * `canvas.adapters`, so a caller passes the 风格's adapters in there too.
 */
export function compileCanvasPrompt(canvas: CompileSource, profiles: LoraTriggerProfiles = {}): CompiledPrompt {
  const written = canvasDescription(canvas).trim()
  const regions = visibleLayers(canvas.layers).length
  // An empty description stays an error: trigger words alone are not a picture.
  const description = written ? applyLoraAutoTriggers(written, canvas.adapters ?? [], profiles) : ''
  if (regions === 0) {
    if (!description) return { ok: false, prompt: '', preview: '', source: 'text', regions: 0, errors: [EMPTY_PROMPT_ERROR] }
    return { ok: true, prompt: description, preview: description, source: 'text', regions: 0, errors: [] }
  }
  // compileLayout leaves hidden regions out of both validation and output.
  const draft = canvasToDraft(canvas)
  const result = compileLayout(description === written ? draft : { ...draft, summary: { ...draft.summary, caption: description } })
  if (!result.ok) return { ok: false, prompt: '', preview: '', source: 'layout', regions, errors: result.errors }
  return { ok: true, prompt: result.prompt, preview: result.preview, source: 'layout', regions, errors: [] }
}

/*
 * LoRA trigger words in the description. A trigger counts as present when it
 * appears as a whole phrase (ASCII word boundaries, any case), so `sks` is not
 * found inside `tasks` while a CJK trigger matches inside a CJK sentence.
 */

const SEPARATOR = '[,，、;；]'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function triggerPattern(trigger: string, flags: string): RegExp | null {
  const words = trigger.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return null
  return new RegExp(`(?<![A-Za-z0-9_])${words.map(escapeRegExp).join('\\s+')}(?![A-Za-z0-9_])`, flags)
}

export function promptHasTrigger(prompt: string, trigger: string): boolean {
  return triggerPattern(trigger, 'i')?.test(prompt) ?? false
}

/** Adds the trigger once, at the end (or the start), joined with an English comma. */
export function addTrigger(prompt: string, trigger: string, position: 'prefix' | 'suffix' = 'suffix'): string {
  const word = trigger.replace(/\s+/g, ' ').trim()
  if (!word || promptHasTrigger(prompt, word)) return prompt
  if (position === 'prefix') {
    const body = prompt.replace(new RegExp(`^(?:\\s|${SEPARATOR})+`), '')
    return body ? `${word}, ${body}` : word
  }
  const body = prompt.replace(/\s+$/, '')
  if (!body) return word
  if (/[,;]$/.test(body)) return `${body} ${word}`
  if (new RegExp(`${SEPARATOR}$`).test(body)) return `${body}${word}`
  return `${body}, ${word}`
}

/** Removes every occurrence and the separator it leaves behind; other lines stay as written. */
export function removeTrigger(prompt: string, trigger: string): string {
  const pattern = triggerPattern(trigger, 'gi')
  if (!pattern) return prompt
  return prompt
    .split('\n')
    .map((line) => {
      if (!line.match(pattern)) return line
      return line
        .replace(pattern, '')
        .replace(new RegExp(`[ \\t]+(${SEPARATOR})`, 'g'), '$1')
        .replace(new RegExp(`(${SEPARATOR})(?:[ \\t]*${SEPARATOR})+`, 'g'), '$1')
        .replace(new RegExp(`^[ \\t]*${SEPARATOR}[ \\t]*`), '')
        .replace(new RegExp(`[ \\t]*${SEPARATOR}[ \\t]*$`), '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
    })
    .join('\n')
}

/**
 * What the engine receives for LoRAs set to 自动前置 / 自动后置: their trigger
 * words not already in the description, in adapter order, each only once.
 */
export function applyLoraAutoTriggers<A extends Pick<CanvasAdapter, 'id' | 'path'>>(
  prompt: string,
  adapters: readonly A[],
  profiles: LoraTriggerProfiles,
): string {
  const prefix: string[] = []
  const suffix: string[] = []
  const taken = new Set<string>()
  for (const adapter of adapters) {
    const profile = profileFor(profiles, adapter)
    if (!profile?.autoInsert || profile.autoInsert === 'manual') continue
    for (const word of profile.triggers) {
      const key = word.toLowerCase()
      if (taken.has(key) || promptHasTrigger(prompt, word)) continue
      taken.add(key)
      ;(profile.autoInsert === 'prefix' ? prefix : suffix).push(word)
    }
  }
  if (!prefix.length && !suffix.length) return prompt
  let body = prompt.trim()
  if (prefix.length) body = body.replace(new RegExp(`^(?:\\s|${SEPARATOR})+`), '')
  if (suffix.length) body = body.replace(new RegExp(`(?:\\s|${SEPARATOR})+$`), '')
  return [prefix.join(', '), body, suffix.join(', ')].filter(Boolean).join(', ')
}
