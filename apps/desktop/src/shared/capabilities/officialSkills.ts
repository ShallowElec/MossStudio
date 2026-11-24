/*
 * The two guides below are adapted from the MOSS-Image prompt-enhancer skill
 * (skills/moss-image-prompt-enhancer/SKILL.md and references/layout.md in
 * https://github.com/OpenMOSS/MOSS-Image), copyright the MOSS-Image authors and
 * licensed under the Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
 * Changed for MossStudio: rewritten, extended with MossStudio's own prompt and
 * layout rules, and pointed at MossStudio's own board tools instead of a JSON
 * output format. Each guide names its source and licence where an Agent reads it.
 * Each is also a Skill pack (`skill.moss.standard`, `skill.moss.layout`) that
 * stays out of the active Skill until the person turns it on.
 */
export const MOSS_PROMPTCRAFT_SKILL_MD = `# MOSS Promptcraft Skill (Standard Caption Mode)

Adapted from https://github.com/OpenMOSS/MOSS-Image/blob/main/skills/moss-image-prompt-enhancer/SKILL.md (Apache License 2.0), changed for MossStudio and extended with MossStudio prompt-writing rules.

## 1. Ordering (Macro -> Micro)
Write prompts in macro-to-micro order:
1. **Medium, art style & camera framing**: lead with the visual medium, style era/technique, focal feel, camera angle, and shot scale (e.g. "High-taste 2D digital painting with selective focus, medium three-quarter shot, slight low angle" or "Candid 35mm film photograph, harsh direct on-camera flash, deep depth of field").
2. **Environment & global lighting**: establish setting, key light direction/temperature, fill/rim light, and shadow behavior BEFORE describing skin or fabric.
3. **Subject pose, orientation & gaze**: state exact body/head orientation ("viewer left", "her right hand"), physical contact points, and subtle expression.
4. **Layered attire & visible materials**: describe garments from outer layer inward with tangible surface response (matte weave, translucent chiffon, specular leather, damp sheen) rather than cluttered micro-patterns.
5. **Background props & palette anchor**: finish with secondary props and a restrained 2-4 color harmony (or explicit hex palette such as "Dominant palette: #1e293b, #f8fafc, accent #f59e0b").

## 2. Visible Detail
- **Describe visible optical/painterly results, never bare gear or engine names**: name what the eye sees (hard flash drop shadows, film grain, gouache brushwork, cel-shaded hard shadows).
- **Selective focus & finish**: concentrate crisp detail on eyes, eyelashes, lips, hair wisps, and hands while allowing breathable brushwork or natural depth-of-field falloff on secondary clothing folds and backgrounds.
- **Multi-subject scenes**: for compact single-subject scenes, write one cohesive English paragraph. When two or more subjects or distinct depth layers share a pure Caption without region boxes, keep all attributes of one subject together.
- **Exact visible text**: quote any intended visible text verbatim in its original language, preserving punctuation, casing, and line breaks; never use placeholders like "headline here" and never leak JSON/tool/coordinate notes into the prompt.

## 3. MossStudio Standard Caption Workflow
1. Call \`studio.board.read_context\` (or \`studio_read_context\`) first to inspect the selected Canvas, size, prompt, regions, model, and LoRAs.
2. Check \`models.catalog.installed\` (or \`remote.hosts.loras_list\` when running on a Worker host) before changing models or LoRAs; honor each active LoRA's real trigger words and the model's own defaults.
3. In Standard Caption mode, write the prompt via \`studio.board.set_prompt\` without adding regions. If the Canvas already has regions, ask the person before removing any of them.
4. Verify readiness via \`studio.board.diagnose\`, then start generation with \`studio.runs.generate\` when requested by the user.`

export const MOSS_LAYOUT_DESIGN_SKILL_MD = `# MOSS Layout Design Skill (Spatial Region Mode)

Adapted from https://github.com/OpenMOSS/MOSS-Image/blob/main/skills/moss-image-prompt-enhancer/references/layout.md (Apache License 2.0) with MossStudio spatial-composition rules.

## 1. When and How Layout Mode Works in MossStudio
- Use Layout mode whenever spatial control matters: multi-character staging, posters, typography/signage, comics/multi-panel pages, asymmetric compositions, or exact object-to-character relationships. Even a single-subject scene can use Layout to lock framing, scale, and negative space.
- MossStudio stores the global scene description on the Canvas prompt (\`summary.caption\`) and stores spatial items as Canvas regions (\`object\`, \`character\`, \`text\`). When generating, MossStudio's built-in compiler automatically converts normalized \`0..1\` \`{x, y, w, h}\` boxes on the active \`width × height\` (multiples of 16) into MOSS-Image's centered integer \`abs_centralized\` / \`yxyx\` JSON.
- **Never** hand-write raw Layout JSON into \`studio.board.set_prompt\`, **never** compute \`abs_centralized\` / \`yxyx\` coordinates by hand, and **never** invoke external \`compile_prompt.py\` scripts. Always use \`studio.regions.add\`, \`studio.regions.add_text\`, \`studio.regions.update\`, and \`studio.regions.remove\`.

## 2. Global Summary vs Per-Region Captions
- **Global Canvas prompt (\`studio.board.set_prompt\`)**: acts as \`summary.caption\`. Lead with overall medium, art style, lighting, color harmony, and—for multi-panel or recurring characters—a concise character appearance sheet that every region below stays consistent with.
- **Region labels (\`character\` vs \`object\` vs \`text\`)**:
  - Use \`character\` ONLY for regions containing a person/creature with a head/body. For inset close-ups of eyes, lips, hands, shoes, or props, use \`object\` and start the caption with \`Extreme close-up showing ONLY ...\`.
  - Separate two characters into two distinct \`character\` regions with clear horizontal/vertical separation or intentional overlap, repeating core hair/eye/outfit anchors in each region caption so traits never swap.
  - A bounding box is a placement guide, NOT a drawn frame, card, or sticker; natural overlap and occlusion between boxes are supported. Make sure spatial words in captions ("on the left", "in the upper right") agree with their box coordinates.
- **Typography & comic speech bubbles (\`studio.regions.add_text\`)**:
  - \`caption\` describes ONLY typography, lettering style, color, surface/container, and bubble geometry—never the rendered words themselves.
  - \`text\` holds the exact characters to render (with \`\\n\` for intended line breaks and no surrounding quotes).
  - For comic/dialogue bubbles, disambiguate speaker attribution via geometry and pointer direction:
    - Spoken by an on-screen character: place the box near that speaker's head and write \`Clean [vertical/horizontal] [Chinese/English] spoken dialogue inside a rounded oval comic speech bubble with a pointer tail pointing [down/left/right] toward [Character]'s head\`.
    - Off-screen / POV monologue: write \`inside a tail-less oval thought bubble (smooth outline with NO pointer tail pointing to any character)\`.
    - Narration / title / label box: write \`inside a sharp-cornered rectangular narration box (no bubble tail)\`—never write the literal word "旁白" into \`text\`.
  - Leave generous breathing room inside text boxes; for multi-panel pages, align sibling panel top edges.

## 3. MossStudio Layout Workflow & Revision Discipline
1. Read the current Canvas with \`studio.board.read_context\`. Pick Canvas dimensions first (\`studio.sampling.set\`, multiples of 16 matching the intended aspect ratio).
2. Write the global scene/style summary via \`studio.board.set_prompt\`, then populate or refine regions via \`studio.regions.add\` (\`label: "character" | "object"\`, \`caption\`, normalized \`0..1\` \`bbox: { x, y, w, h }\`) and \`studio.regions.add_text\` (\`caption\` + exact \`text\` + \`bbox\`).
3. Run \`studio.board.diagnose\` after every geometry or text edit to verify compiled Layout validity and resolve any bounds/empty-text errors before calling \`studio.runs.generate\`.
4. When revising an existing Canvas on a fixed seed, preserve \`summary.caption\` and untouched regions, updating only the specific region indices (\`studio.regions.update\`) that need adjustment so character identity and composition stay stable.`

export type GuideTopic = 'all' | 'tools' | 'promptcraft' | 'layout'

export function composeOfficialGuide(tools: string, topic: GuideTopic = 'all'): string {
  if (topic === 'tools') return tools
  if (topic === 'promptcraft') return MOSS_PROMPTCRAFT_SKILL_MD
  if (topic === 'layout') return MOSS_LAYOUT_DESIGN_SKILL_MD
  const extra = [
    !tools.includes('# MOSS Promptcraft Skill') ? MOSS_PROMPTCRAFT_SKILL_MD : '',
    !tools.includes('# MOSS Layout Design Skill') ? MOSS_LAYOUT_DESIGN_SKILL_MD : '',
  ].filter(Boolean)
  return [tools, ...extra].join('\n\n')
}
