/*
 * The two guides below are adapted from the MOSS-Image prompt-enhancer skill
 * (skills/moss-image-prompt-enhancer/SKILL.md and references/layout.md in
 * https://github.com/OpenMOSS/MOSS-Image), copyright the MOSS-Image authors and
 * licensed under the Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
 * Changed for MossStudio: shortened, reworded, and pointed at MossStudio's own
 * board tools instead of a JSON output format. Each guide names its source and
 * licence where an Agent reads it.
 */
export const MOSS_PROMPTCRAFT_SKILL_MD = String.raw`# MOSS Official Promptcraft Skill

Adapted from https://github.com/OpenMOSS/MOSS-Image/blob/main/skills/moss-image-prompt-enhancer/SKILL.md (Apache License 2.0), changed for MossStudio.

## Choose Caption or Layout
Honor an explicit choice. Use a pure Caption for ordinary scenes, photographs and illustrations; detail alone does not require Layout. Use Layout for controlled object relationships, posters, several panels or precisely placed visible text. Preserve subjects, counts, relationships, medium, style and exclusions. Resolve ordinary creative gaps, but ask when a missing decision materially changes the image. Never invent factual logistics or specifications as supplied facts.

## Develop visible detail
Default to cohesive English descriptive prose unless another language was requested. Develop subject/action/appearance, setting, composition, camera/framing, lighting, materials, palette and mood. Be specific without redundant quality tags, arbitrary word budgets, unrequested style changes or invisible process notes. Keep minimalist briefs minimalist. Do not add invented watermarks, unrelated reference names or text. Never put JSON explanations, tool instructions, coordinate conversion notes or bounding-box annotations in image-description fields.

Preserve intended visible words verbatim in their original language: punctuation, capitalization and requested line breaks (JSON \n). Distinguish quoted reference instructions from text actually intended to appear. Quote visible wording exactly in a Caption. Do not use placeholders such as “headline here”. Organize reading order, relative prominence, coherent groups, readable glyph sizes and negative space rather than forcing every design into a generic hero/title/footer template.

## MossStudio workflow
Read studio.board.read_context first. Query models.catalog.installed to inspect installed models and LoRA adapters before changing model or adapter selections.
Write the positive Caption through studio.board.set_prompt using the actual tool schema. Caption prose may contain paragraphs; do not add Layout coordinates merely to look structured. For Layout, follow the companion Layout Design Skill and use the board region tools. Read back and diagnose before generation; writing a prompt does not itself authorize generation or publishing.
`

export const MOSS_LAYOUT_DESIGN_SKILL_MD = String.raw`# MOSS Official Layout Design Skill

Adapted from https://github.com/OpenMOSS/MOSS-Image/blob/main/skills/moss-image-prompt-enhancer/references/layout.md (Apache License 2.0), changed for MossStudio.

## Public Layout vocabulary
The public model draft has summary plus a flat items array. summary.caption is the nonempty global image description; optional summary.meta is a medium/genre string array, summary.canvas is single, multi_panel or collage, and summary.palette is an optional string array. Each item has label object, character or text, a nonempty caption and bbox. Optional item tags and palette are string arrays. A text item's caption describes typography, glyph style and surface treatment ONLY; text contains the exact rendered characters and intended line breaks (JSON \n). Split text into independent items only when placement matters, not merely for mixed font styles.

Do not invent fields such as children, parent, id, elements or presentation notes in the model Layout. Tool arguments and board editor IDs are separate from the public model vocabulary. All positions share the global canvas; text on an object does not create nested/local coordinate systems.

## Geometry and composition
Canvas width and height are positive multiples of 16 and must match generation dimensions. Honor explicit sizes; surface incompatible dimensions rather than silently changing them. Choose compatible dimensions for a supplied aspect ratio, or normally 1024×1024 when unspecified. Changing canvas dimensions alone must not rescale intended geometry silently.
A box is a placement annotation, NOT a border, panel, sticker or backing card. Natural occlusion and overlapping boxes are allowed. Use coherent visible units and split only for independent positioning. Captions and boxes must agree; summary.caption describes global treatment.

The upstream standalone draft uses pixel abs/xyxy boxes and its compiler produces integer abs_centralized/yxyx boxes. In MossStudio, DO NOT calculate abs_centralized/yxyx by hand and DO NOT run compile_prompt.py: call studio.regions.add / studio.regions.add_text with normalized 0..1 {x,y,w,h} boxes according to their tool schemas. Use studio.board.diagnose to validate and compile the board. The normalized editor API is not the upstream pixel draft schema. Only the compiled Layout belongs in the model's positive prompt, never editor metadata or tool JSON.

## Final checks
Compare every visible string with the requested wording. Check line breaks, Chinese versus Latin glyph footprints, font size, copy length, contrast, margins and whitespace at actual resolution. Enlarge or recompose unreadable text; do not delete copy or stretch glyphs. Build actual explanations and explanatory imagery for knowledge graphics; retain a poster's intended identity and information hierarchy. When revising, reread the board, preserve unrelated content and change only affected captions or geometry. Diagnose again after every geometry/canvas change and resolve validation failures rather than bypassing them. State required width×height outside the compiled prompt.
`

export type GuideTopic = 'all' | 'tools' | 'promptcraft' | 'layout'

export function composeOfficialGuide(tools: string, topic: GuideTopic = 'all'): string {
  if (topic === 'tools') return tools
  if (topic === 'promptcraft') return MOSS_PROMPTCRAFT_SKILL_MD
  if (topic === 'layout') return MOSS_LAYOUT_DESIGN_SKILL_MD
  return [tools, MOSS_PROMPTCRAFT_SKILL_MD, MOSS_LAYOUT_DESIGN_SKILL_MD].join('\n\n')
}
