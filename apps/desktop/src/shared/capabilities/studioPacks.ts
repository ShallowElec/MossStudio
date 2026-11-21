import { z } from 'zod'
import { ADAPTERS_PER_CANVAS_MAX, ADAPTER_STRENGTH_MAX, ADAPTER_STRENGTH_MIN } from '../adapters'
import { TOOL_SCHEMAS, type ToolName } from '../agent/schemas'
import { createCapabilityRegistry, type CapabilityRegistry } from './registry'
import { CAPABILITY_PROTOCOL_VERSION, type BuiltinCapabilityPack } from './protocol'

/**
 * Built-in Studio capability packs.
 *
 * Every existing `studio_*` assistant tool is defined here once (reusing its
 * exact Zod schema from `shared/agent/schemas.ts`) alongside the full Studio
 * pure-function actions for cards, regions, wires, sampling and runs.
 */

const boxSchema = z
  .strictObject({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0.02).max(1),
    h: z.number().min(0.02).max(1),
  })
  .describe('Normalised box: x and y are the top-left corner, w and h the size, all 0-1 of the canvas.')

const optionalCanvasId = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .optional()
  .describe('Target canvas id. Omit to act on the currently selected canvas.')

const adapterSchema = z.strictObject({
  id: z.string().trim().min(1).max(160).describe('LoRA adapter id from the model library.'),
  strength: z.number().min(ADAPTER_STRENGTH_MIN).max(ADAPTER_STRENGTH_MAX).describe('LoRA weight, 0-2 (default 1).'),
})

export const STUDIO_ACTION_SCHEMAS = {
  // ---- studio.board.read ----
  'studio.board.read_context': TOOL_SCHEMAS.studio_read_context,
  'studio.board.select_canvas': TOOL_SCHEMAS.studio_select_canvas,
  'studio.board.read_canvas': TOOL_SCHEMAS.studio_read_canvas,
  'studio.board.diagnose': z.strictObject({
    canvasId: optionalCanvasId,
  }),

  // ---- studio.ask ----
  'studio.ask.user': TOOL_SCHEMAS.studio_ask_user,
  'studio.ask.approval': TOOL_SCHEMAS.studio_ask_approval,

  // ---- studio.board.cards ----
  'studio.board.set_prompt': TOOL_SCHEMAS.studio_set_prompt,
  'studio.board.create_scenes': TOOL_SCHEMAS.studio_create_scenes,
  'studio.cards.create': z.strictObject({
    title: z.string().trim().min(1).max(60).optional().describe('Optional title for the new layout canvas.'),
    prompt: z.string().trim().max(4000).optional().describe('Optional initial English description.'),
    width: z.number().int().min(256).max(2048).optional().describe('Canvas width in pixels, snapped to 16 px.'),
    height: z.number().int().min(256).max(2048).optional().describe('Canvas height in pixels, snapped to 16 px.'),
    modelBundleId: z.string().trim().min(1).max(160).optional().describe('Optional model bundle id to bind to the new canvas.'),
    select: z.boolean().optional().describe('True to select the created canvas (default true).'),
  }),
  'studio.cards.duplicate': z.strictObject({
    canvasId: optionalCanvasId,
    select: z.boolean().optional().describe('True to select the copied layout canvas (default true).'),
  }),
  'studio.cards.create_style': z.strictObject({
    title: z.string().trim().min(1).max(60).optional().describe('Optional style card title.'),
    prompt: z.string().trim().max(4000).optional().describe('Shared English style description.'),
    adapters: z.array(adapterSchema).max(ADAPTERS_PER_CANVAS_MAX).optional().describe('Shared LoRA adapters applied to linked canvases.'),
    select: z.boolean().optional().describe('True to select the new style card (default false).'),
  }),
  'studio.cards.create_upscale': z.strictObject({
    sourceCanvasId: z.string().trim().min(1).max(80).describe('Source canvas id that has a picture to upscale.'),
    scale: z
      .union([z.literal(1.5), z.literal(2)])
      .optional()
      .describe('Upscale factor: 1.5 or 2 (default 2).'),
    strength: z.number().min(0).max(1).optional().describe('Redraw strength: 0.25 keep, 0.4 balanced, 0.55 more detail.'),
    select: z.boolean().optional().describe('True to select the new upscale canvas (default true).'),
  }),
  'studio.cards.set_upscale_scale': z.strictObject({
    canvasId: optionalCanvasId,
    scale: z.union([z.literal(1.5), z.literal(2)]).describe('Upscale factor: 1.5 or 2.'),
  }),
  'studio.cards.delete': z.strictObject({
    canvasId: z.string().trim().min(1).max(80).describe('Canvas id to remove from the board (generated images stay in Library).'),
  }),
  'studio.cards.tidy': z.strictObject({
    canvasIds: z
      .array(z.string().trim().min(1).max(80))
      .min(2)
      .max(200)
      .optional()
      .describe('Specific canvas ids to arrange neatly; omit to arrange every visible board card.'),
  }),

  // ---- studio.board.regions ----
  'studio.regions.add': TOOL_SCHEMAS.studio_add_layer,
  'studio.regions.add_text': TOOL_SCHEMAS.studio_add_text_layer,
  'studio.regions.update': TOOL_SCHEMAS.studio_update_layer,
  'studio.regions.remove': TOOL_SCHEMAS.studio_remove_layer,
  'studio.regions.update_by_id': z.strictObject({
    canvasId: optionalCanvasId,
    layerId: z.string().trim().min(1).max(120).describe('Stable region id reported by studio_read_context / studio_read_canvas.'),
    caption: z.string().trim().min(1).max(600).optional().describe('New English description of the region.'),
    text: z.string().trim().max(400).optional().describe('New rendered characters on a text region.'),
    bbox: boxSchema.optional().describe('New normalised position and size.'),
    visible: z.boolean().optional().describe('False hides the region from generation.'),
    opacity: z.number().min(0.1).max(1).optional().describe('Region opacity, 0.1-1.'),
  }),
  'studio.regions.remove_by_id': z.strictObject({
    canvasId: optionalCanvasId,
    layerId: z.string().trim().min(1).max(120).describe('Stable region id to delete.'),
  }),
  'studio.regions.reorder': z.strictObject({
    canvasId: optionalCanvasId,
    fromLayerId: z.string().trim().min(1).max(120).describe('Region id to move.'),
    toLayerId: z.string().trim().min(1).max(120).describe('Region id whose position `fromLayerId` takes.'),
  }),

  // ---- studio.board.sampling ----
  'studio.sampling.set': TOOL_SCHEMAS.studio_set_sampler,
  'studio.sampling.set_model': z.strictObject({
    canvasId: optionalCanvasId,
    modelBundleId: z.string().trim().min(1).max(160).describe('Model bundle id from the installed catalog.'),
  }),
  'studio.sampling.set_loras': z.strictObject({
    canvasId: optionalCanvasId,
    adapters: z.array(adapterSchema).max(ADAPTERS_PER_CANVAS_MAX).describe('Complete LoRA list for the canvas or style card.'),
  }),
  'studio.sampling.set_advanced': z.strictObject({
    canvasId: optionalCanvasId,
    sampler: z.string().trim().max(60).nullable().optional().describe('Sampler name, or null to reset to engine default.'),
    scheduler: z.string().trim().max(60).nullable().optional().describe('Scheduler name, or null to reset to engine default.'),
    shift: z.number().min(0).max(20).nullable().optional().describe('Flow shift value, or null to reset.'),
    stepCache: z.string().trim().max(40).nullable().optional().describe('Step cache mode (`off` / `fbcache`), or null to reset.'),
    cfgTruncation: z.number().min(0).max(1).nullable().optional().describe('CFG truncation ratio 0-1, or null to reset.'),
    hires: z
      .strictObject({
        enabled: z.boolean().describe('False disables hires fix.'),
        scale: z.number().min(1).max(4).optional().describe('Convenience scale relative to canvas size (e.g. 1.5 or 2).'),
        width: z.number().int().min(256).max(4096).optional().describe('Explicit hires target width.'),
        height: z.number().int().min(256).max(4096).optional().describe('Explicit hires target height.'),
        steps: z.number().int().min(1).max(100).optional().describe('Second-pass denoise steps.'),
        strength: z.number().min(0).max(1).optional().describe('Second-pass redraw strength.'),
      })
      .optional()
      .describe('Hires fix settings.'),
  }),

  // ---- studio.board.wires ----
  'studio.wires.connect': z.strictObject({
    sourceCanvasId: z.string().trim().min(1).max(80).describe('Source canvas id (a picture, result, layout with picture, or style card).'),
    targetCanvasId: optionalCanvasId,
    role: z.enum(['init', 'control', 'reference', 'style']).describe('Input slot role on the target canvas.'),
    kind: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .optional()
      .describe('Control kind (required when role is `control`, e.g. depth / canny / pose).'),
    output: z.number().int().min(0).max(16).optional().describe('Optional output index when the source has multiple outputs.'),
  }),
  'studio.wires.disconnect': z.strictObject({
    targetCanvasId: optionalCanvasId,
    role: z.enum(['init', 'control', 'reference', 'style']).describe('Input slot role to disconnect.'),
    kind: z.string().trim().min(1).max(40).optional().describe('Control kind when disconnecting a control wire by kind.'),
    index: z.number().int().min(0).max(16).optional().describe('0-based index when disconnecting a reference, style, or control wire.'),
  }),
  'studio.wires.configure_init': z.strictObject({
    canvasId: optionalCanvasId,
    strength: z.number().min(0).max(1).optional().describe('Redraw strength 0-1 (default 0.6).'),
    resize: z.enum(['crop', 'fit', 'stretch']).nullable().optional().describe('Start picture resize mode, or null for engine default.'),
  }),
  'studio.wires.configure_control': z.strictObject({
    canvasId: optionalCanvasId,
    adapterId: z.string().trim().max(160).optional().describe('Control adapter id; empty string disables control inputs.'),
    loraStrength: z.number().min(0).max(2).nullable().optional().describe('Control adapter LoRA weight 0-2, or null for default.'),
    image: z
      .strictObject({
        kind: z.string().trim().min(1).max(40).describe('Control kind to tune.'),
        strength: z.number().min(0).max(10).optional().describe('Guidance strength 0-10.'),
        start: z.number().min(0).max(1).optional().describe('Fraction of denoise where control starts (0-1).'),
        end: z.number().min(0).max(1).optional().describe('Fraction of denoise where control ends (0-1).'),
      })
      .optional()
      .describe('Optional per-kind control image tuning.'),
  }),
  'studio.wires.configure_references': z.strictObject({
    canvasId: optionalCanvasId,
    maxEdge: z.number().int().min(16).max(2048).nullable().describe('Longest edge in pixels (16-2048), or null for engine default.'),
  }),
  'studio.wires.apply_recipe': z.strictObject({
    recipe: z.enum(['series', 'edit', 'style', 'upscale']).describe('Board recipe to lay out.'),
    sourceCanvasId: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe('Existing picture canvas id required for `edit`, `style` and `upscale` recipes.'),
    select: z.boolean().optional().describe('True to select the primary created canvas (default true).'),
  }),

  // ---- studio.board.runs ----
  'studio.runs.generate': TOOL_SCHEMAS.studio_generate,
  'studio.runs.cancel': z.strictObject({
    canvasId: optionalCanvasId,
    jobId: z.string().trim().min(1).max(120).optional().describe('Explicit job id to cancel; falls back to the canvas active job.'),
  }),
  'studio.runs.pin': z.strictObject({
    runId: z.string().trim().min(1).max(80).describe('Result canvas id from a layout filmstrip to pin onto the board.'),
  }),
  'studio.runs.unpin': z.strictObject({
    runId: z.string().trim().min(1).max(80).describe('Pinned result canvas id to fold back into its layout filmstrip.'),
  }),
  'studio.runs.apply_settings': z.strictObject({
    layoutCanvasId: optionalCanvasId,
    runId: z.string().trim().min(1).max(80).describe('Result canvas id whose generation settings will be copied back onto the layout.'),
  }),
  'studio.runs.drop': z.strictObject({
    runId: z.string().trim().min(1).max(80).describe('Folded run id to remove from its filmstrip (picture stays in Library).'),
  }),
} as const

export type StudioActionId = keyof typeof STUDIO_ACTION_SCHEMAS
export type StudioActionArgs<Id extends StudioActionId> = z.infer<(typeof STUDIO_ACTION_SCHEMAS)[Id]>

/** Preserves the historical tool ordering expected by the built-in assistant and its tests. */
export const LEGACY_TOOL_ORDER: readonly ToolName[] = [
  'studio_read_context',
  'studio_select_canvas',
  'studio_read_canvas',
  'studio_ask_user',
  'studio_ask_approval',
  'studio_set_prompt',
  'studio_set_sampler',
  'studio_add_layer',
  'studio_add_text_layer',
  'studio_update_layer',
  'studio_remove_layer',
  'studio_generate',
  'studio_create_scenes',
]

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function short(value: string, limit = 20): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export const STUDIO_CAPABILITY_PACKS: readonly BuiltinCapabilityPack[] = [
  {
    protocolVersion: CAPABILITY_PROTOCOL_VERSION,
    id: 'studio.board.read',
    title: '画板读取与诊断',
    version: '1.0.0',
    requiresPacks: [],
    actions: [
      {
        id: 'studio.board.read_context',
        legacyAlias: 'studio_read_context',
        legacyPack: 'canvas.read',
        title: '查看画面',
        description:
          'Read the workbench: the selected Canvas (size, sampler values, description) and every region with its 1-based index, kind, caption, text and box. Call it before changing anything you have not just seen.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.board.read_context'],
        target: 'renderer',
        scope: 'project',
        effects: ['read'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: () => '当前画面',
      },
      {
        id: 'studio.board.select_canvas',
        legacyAlias: 'studio_select_canvas',
        legacyPack: 'canvas.read',
        title: '切换画面',
        description:
          'Make another Canvas of the project the selected one. Every tool that edits "the selected Canvas" works on it afterwards. Only the selection changes, never the picture.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.board.select_canvas'],
        target: 'renderer',
        scope: 'project',
        effects: ['select'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => `切到 ${short(text(args.id), 16)}`,
      },
      {
        id: 'studio.board.read_canvas',
        legacyAlias: 'studio_read_canvas',
        legacyPack: 'canvas.read',
        title: '读取画面',
        description:
          'Read one Canvas by id without selecting it: the same detail studio_read_context gives for the selected one, plus whether it is the one selected. Use it to compare the pictures of a set, or to look at one you are not on.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.board.read_canvas'],
        target: 'renderer',
        scope: 'project',
        effects: ['read'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => `读 ${short(text(args.id), 16)}`,
      },
      {
        id: 'studio.board.diagnose',
        title: '检查就绪状态',
        description:
          'Inspect full generation readiness for a layout Canvas: prompt compilation, model bundle, engine readiness, LoRA availability, input wire blockers, busy branch status and supported engine features.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.board.diagnose'],
        target: 'renderer',
        scope: 'project',
        effects: ['read'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => (text(args.canvasId) ? `诊断 ${short(text(args.canvasId), 16)}` : '诊断当前画面'),
      },
    ],
    contexts: [
      {
        id: 'studio.context.snapshot',
        description: 'Current project canvas list plus selected canvas description and regions.',
        scope: 'project',
        target: 'renderer',
        output: { type: 'object' },
        maxBytes: 16_000,
        binding: { kind: 'builtin', handlerId: 'studio.context.snapshot' },
      },
    ],
    skills: [
      {
        id: 'studio.skill.read',
        requiresActions: ['studio.board.read_context'],
        order: 10,
        audience: ['tools', 'resources'],
        markdown: [
          '## Reading the Board',
          '- Call `studio_read_context` before changing anything you have not just inspected.',
          '- Use `studio_read_canvas` to inspect another canvas by id without moving the user selection.',
          '- When diagnosing why a canvas cannot generate, inspect blockers with `studio.board.diagnose`.',
        ].join('\n'),
      },
    ],
  },
  {
    protocolVersion: CAPABILITY_PROTOCOL_VERSION,
    id: 'studio.ask',
    title: '人机交互卡片',
    version: '1.0.0',
    requiresPacks: [],
    actions: [
      {
        id: 'studio.ask.user',
        legacyAlias: 'studio_ask_user',
        legacyPack: 'ask',
        title: '问你一句',
        description:
          'Ask the user one question and show it as a card with 2-5 choices (single or multiple). Use it when the answer decides the picture and you cannot read it from the canvas: composition, character details, sizes, wording. After calling it, stop your turn: the user answers on the card and the next turn continues.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.ask.user'],
        target: 'renderer',
        scope: 'session',
        effects: ['interact'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => `问：${short(text(args.question), 24)}`,
      },
      {
        id: 'studio.ask.approval',
        legacyAlias: 'studio_ask_approval',
        legacyPack: 'ask',
        title: '等你确认',
        description:
          'Ask the user to approve or reject one concrete next step: starting a generation, a batch of pictures, anything that spends GPU time or cannot be undone. Shows a card with approve, reject and "change it" buttons. Use it instead of asking "要开始吗" in prose. After calling it, stop your turn.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.ask.approval'],
        target: 'renderer',
        scope: 'session',
        effects: ['interact'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => `等你确认：${short(text(args.question), 22)}`,
      },
    ],
    contexts: [],
    skills: [
      {
        id: 'studio.skill.ask',
        requiresActions: ['studio.ask.user', 'studio.ask.approval'],
        order: 90,
        audience: ['tools', 'resources'],
        markdown: [
          '## Asking the User',
          '- Use `studio_ask_user` for 2-5 concrete choices; use `studio_ask_approval` only for yes/no go-ahead steps.',
          '- Stop your turn immediately after emitting an ask card so the user can answer it.',
        ].join('\n'),
      },
    ],
  },
  {
    protocolVersion: CAPABILITY_PROTOCOL_VERSION,
    id: 'studio.board.cards',
    title: '画板卡片管理',
    version: '1.0.0',
    requiresPacks: ['studio.board.read'],
    actions: [
      {
        id: 'studio.board.set_prompt',
        legacyAlias: 'studio_set_prompt',
        legacyPack: 'canvas.write',
        title: '改写描述',
        description:
          'Replace the description of the selected Canvas. Plain English descriptive prose (one or more paragraphs). Writes immediately and is visible to the user.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.board.set_prompt'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: ['editable-or-style'],
        headless: 'requires-ui',
        summarize: (args) => `描述改为「${short(text(args.prompt))}」`,
      },
      {
        id: 'studio.board.create_scenes',
        legacyAlias: 'studio_create_scenes',
        legacyPack: 'storyboard',
        title: '建一套画面',
        description:
          'Build a set of layout Canvases in one go, one per scene, each with its description, regions and words. Use it when the user wants a series, a storyboard or several pictures at once: plan every scene first, then call this once. The result lists the new ids; select one with studio_select_canvas to refine it.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.board.create_scenes'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => {
          const scenes = Array.isArray(args.scenes) ? (args.scenes as Array<{ title?: unknown }>) : []
          const titles = scenes.map((scene) => text(scene?.title)).filter(Boolean)
          return titles.length
            ? `新建 ${scenes.length} 个画面：${short(titles.slice(0, 3).join('、'), 48)}`
            : `新建 ${scenes.length} 个画面`
        },
      },
      {
        id: 'studio.cards.create',
        title: '新建画面',
        description: 'Create one new editable layout Canvas in a free board spot with optional title, English description, size and model.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.cards.create'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => (text(args.title) ? `新建画面「${short(text(args.title))}」` : '新建画面'),
      },
      {
        id: 'studio.cards.duplicate',
        title: '复制为新画面',
        description: 'Copy a layout or result Canvas into a new editable layout Canvas placed beside it.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.cards.duplicate'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => (text(args.canvasId) ? `复制 ${short(text(args.canvasId), 16)}` : '复制当前画面'),
      },
      {
        id: 'studio.cards.create_style',
        title: '新建风格',
        description: 'Create a 风格 (style) card carrying a shared English description and LoRA list that layout Canvases can wire to.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.cards.create_style'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => (text(args.title) ? `新建风格「${short(text(args.title))}」` : '新建风格'),
      },
      {
        id: 'studio.cards.create_upscale',
        title: '新建放大',
        description: 'Create an upscale Canvas fed by an existing picture or result Canvas at 1.5x or 2x scale.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.cards.create_upscale'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => `放大 ${short(text(args.sourceCanvasId), 16)} ×${num(args.scale) ?? 2}`,
      },
      {
        id: 'studio.cards.set_upscale_scale',
        title: '调整放大倍数',
        description: 'Change the scale (1.5 or 2) of an upscale Canvas; its dimensions update from its source picture automatically.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.cards.set_upscale_scale'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => `放大倍数 ×${num(args.scale) ?? '?'}`,
      },
      {
        id: 'studio.cards.delete',
        title: '删除卡片',
        description:
          'Remove a Canvas card and any wires pointing at it from the board (folded runs of a layout are removed too; generated images remain in Library).',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.cards.delete'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['delete'],
        policyFloor: 'approval',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => `删除 ${short(text(args.canvasId), 16)}`,
      },
      {
        id: 'studio.cards.tidy',
        title: '排整齐卡片',
        description: 'Arrange the specified Canvas cards (or every visible board card) into neat non-overlapping rows.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.cards.tidy'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => (Array.isArray(args.canvasIds) ? `排整齐 ${args.canvasIds.length} 张卡片` : '排整齐画板卡片'),
      },
    ],
    contexts: [],
    skills: [
      {
        id: 'studio.skill.cards',
        requiresActions: ['studio.board.set_prompt'],
        order: 20,
        audience: ['tools', 'resources'],
        markdown: [
          '## Descriptions and Cards',
          '- Keep prompts and region captions in English prose; write rendered words in the user language.',
          '- Result cards are read-only; duplicate one with `studio.cards.duplicate` before editing.',
          '- Deleting a card (`studio.cards.delete`) requires approval.',
        ].join('\n'),
      },
    ],
  },
  {
    protocolVersion: CAPABILITY_PROTOCOL_VERSION,
    id: 'studio.board.regions',
    title: '画布区域布局',
    version: '1.0.0',
    requiresPacks: ['studio.board.read'],
    actions: [
      {
        id: 'studio.regions.add',
        legacyAlias: 'studio_add_layer',
        legacyPack: 'canvas.write',
        title: '添加区域',
        description:
          'Add one object or character region to the selected Canvas. Words in the picture are not regions of this kind: use studio_add_text_layer. Regions are what MOSS-Image uses for layout control.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.regions.add'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: ['editable'],
        headless: 'requires-ui',
        summarize: (args) => `${args.label === 'character' ? '人物' : '物体'}「${short(text(args.caption))}」`,
      },
      {
        id: 'studio.regions.add_text',
        legacyAlias: 'studio_add_text_layer',
        legacyPack: 'canvas.write',
        title: '添加文字',
        description:
          'Add one text region: caption says how the lettering looks and where it sits, text is exactly what should be rendered. Use this for titles, signs, labels and any other words in the picture, and only after you know the exact words.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.regions.add_text'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: ['editable'],
        headless: 'requires-ui',
        summarize: (args) => `文字「${short(text(args.text))}」`,
      },
      {
        id: 'studio.regions.update',
        legacyAlias: 'studio_update_layer',
        legacyPack: 'canvas.write',
        title: '修改区域',
        description:
          'Change one region of the selected Canvas by its 1-based index from studio_read_context. Use it to fix or refine a region instead of adding a second one.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.regions.update'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: ['editable'],
        headless: 'requires-ui',
        summarize: (args) => `第 ${num(args.index) ?? '?'} 个区域`,
      },
      {
        id: 'studio.regions.remove',
        legacyAlias: 'studio_remove_layer',
        legacyPack: 'canvas.write',
        title: '删除区域',
        description: 'Delete one region of the selected Canvas by its 1-based index from studio_read_context.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.regions.remove'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: ['editable'],
        headless: 'requires-ui',
        summarize: (args) => `第 ${num(args.index) ?? '?'} 个区域`,
      },
      {
        id: 'studio.regions.update_by_id',
        title: '按 ID 修改区域',
        description:
          'Update a region using its stable `layerId` (and optional `canvasId`) without changing selection or depending on shifting 1-based indices.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.regions.update_by_id'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => `修改区域 ${short(text(args.layerId), 16)}`,
      },
      {
        id: 'studio.regions.remove_by_id',
        title: '按 ID 删除区域',
        description: 'Delete a region using its stable `layerId` (and optional `canvasId`).',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.regions.remove_by_id'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => `删除区域 ${short(text(args.layerId), 16)}`,
      },
      {
        id: 'studio.regions.reorder',
        title: '调整区域顺序',
        description: 'Move one region to another region position in the layer list by stable `fromLayerId` and `toLayerId`.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.regions.reorder'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: () => '重排区域顺序',
      },
    ],
    contexts: [],
    skills: [
      {
        id: 'studio.skill.regions',
        requiresActions: ['studio.regions.add', 'studio.regions.add_text'],
        order: 30,
        audience: ['tools', 'resources'],
        markdown: [
          '## Layout Regions',
          '- Objects and characters use `studio_add_layer`; visible words use `studio_add_text_layer` (`caption` = lettering style, `text` = exact rendered characters).',
          '- Prefer stable `layerId` edits (`studio.regions.update_by_id` / `studio.regions.remove_by_id`) when making multi-step edits.',
        ].join('\n'),
      },
    ],
  },
  {
    protocolVersion: CAPABILITY_PROTOCOL_VERSION,
    id: 'studio.board.sampling',
    title: '模型与采样参数',
    version: '1.0.0',
    requiresPacks: ['studio.board.read'],
    actions: [
      {
        id: 'studio.sampling.set',
        legacyAlias: 'studio_set_sampler',
        legacyPack: 'canvas.write',
        title: '调整参数',
        description:
          'Update sampler values on the selected Canvas. Pass only the fields you want to change; steps snap to the nearest quality preset (8, 20 or 50) and take its CFG unless cfg is given.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.sampling.set'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: ['editable'],
        headless: 'requires-ui',
        summarize: (args) => {
          const size =
            num(args.width) !== undefined || num(args.height) !== undefined ? `${num(args.width) ?? '?'}×${num(args.height) ?? '?'}` : ''
          const steps = num(args.steps) !== undefined ? `${num(args.steps)} 步` : ''
          const cfg = num(args.cfg) !== undefined ? `CFG ${num(args.cfg)}` : ''
          const seed = num(args.seed) !== undefined ? `种子 ${num(args.seed)}` : ''
          const parts = [size, steps, cfg, seed].filter(Boolean)
          return parts.length ? `参数 ${parts.join(' · ')}` : '参数'
        },
      },
      {
        id: 'studio.sampling.set_model',
        title: '切换模型',
        description: 'Bind an installed model bundle to a layout Canvas and adopt its recommended sampling defaults when applicable.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.sampling.set_model'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => `模型 ${short(text(args.modelBundleId), 24)}`,
      },
      {
        id: 'studio.sampling.set_loras',
        title: '配置 LoRA',
        description: 'Replace the LoRA adapter list on a layout or style Canvas (strengths clamped to 0-2, max 16 adapters).',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.sampling.set_loras'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => {
          const list = Array.isArray(args.adapters) ? args.adapters : []
          return list.length ? `配置 ${list.length} 个 LoRA` : '清空 LoRA'
        },
      },
      {
        id: 'studio.sampling.set_advanced',
        title: '高级采样设置',
        description:
          'Update advanced sampling options (sampler, scheduler, shift, stepCache, cfgTruncation and hires fix) on a layout Canvas.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.sampling.set_advanced'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: () => '更新高级采样设置',
      },
    ],
    contexts: [],
    skills: [
      {
        id: 'studio.skill.sampling',
        requiresActions: ['studio.sampling.set'],
        order: 40,
        audience: ['tools', 'resources'],
        markdown: [
          '## Models and Sampling',
          '- Report the actual values returned by `studio_set_sampler`: steps snap to 8, 20 or 50 and dimensions align to 16 px.',
          '- Never edit size or sampling while a canvas has an active generation job.',
        ].join('\n'),
      },
    ],
  },
  {
    protocolVersion: CAPABILITY_PROTOCOL_VERSION,
    id: 'studio.board.wires',
    title: '端口连线与输入配方',
    version: '1.0.0',
    requiresPacks: ['studio.board.read'],
    actions: [
      {
        id: 'studio.wires.connect',
        title: '连接端口',
        description:
          'Wire a source picture or style card into an input slot (`init`, `control`, `reference`, `style`) of a layout Canvas, enforcing cycle and slot checks.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.wires.connect'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => `连线 ${text(args.role) || '输入'} ← ${short(text(args.sourceCanvasId), 14)}`,
      },
      {
        id: 'studio.wires.disconnect',
        title: '断开连线',
        description: 'Remove an existing input wire (`init`, `control`, `reference`, or `style`) from a layout Canvas.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.wires.disconnect'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => `断开 ${text(args.role) || '输入'} 连线`,
      },
      {
        id: 'studio.wires.configure_init',
        title: '调整起始图参数',
        description: 'Update redraw strength (0-1) or resize mode (`crop` / `fit` / `stretch`) on a Canvas that has an `init` wire.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.wires.configure_init'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) =>
          num(args.strength) !== undefined ? `起始图重绘幅度 ${Math.round(num(args.strength)! * 100)}%` : '调整起始图参数',
      },
      {
        id: 'studio.wires.configure_control',
        title: '调整控制图参数',
        description: 'Select a control adapter, tune its LoRA weight, or adjust strength/start/end for a linked control image kind.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.wires.configure_control'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: () => '调整控制图参数',
      },
      {
        id: 'studio.wires.configure_references',
        title: '调整参考图尺寸',
        description: 'Set or clear `maxEdge` (16-2048 px) for linked reference images on a layout Canvas.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.wires.configure_references'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => (num(args.maxEdge) !== undefined ? `参考图最长边 ${num(args.maxEdge)} px` : '重置参考图最长边'),
      },
      {
        id: 'studio.wires.apply_recipe',
        title: '套用画板配方',
        description:
          'Lay out a standard wired node recipe: `series` (one style + three wired layouts), or picture recipes (`edit`, `style`, `upscale`) fed by `sourceCanvasId`.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.wires.apply_recipe'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => `套用配方 ${text(args.recipe) || '?'}`,
      },
    ],
    contexts: [],
    skills: [
      {
        id: 'studio.skill.wires',
        requiresActions: ['studio.wires.connect', 'studio.wires.disconnect'],
        order: 50,
        audience: ['tools', 'resources'],
        markdown: [
          '## Wires and Recipes',
          '- Only editable layout canvases accept incoming wires; cycles and self-links are rejected.',
          '- Replacing an `init` source automatically clears any mask painted over the previous start picture.',
        ].join('\n'),
      },
    ],
  },
  {
    protocolVersion: CAPABILITY_PROTOCOL_VERSION,
    id: 'studio.board.runs',
    title: '生成任务与胶片条',
    version: '1.0.0',
    requiresPacks: ['studio.board.read'],
    actions: [
      {
        id: 'studio.runs.generate',
        legacyAlias: 'studio_generate',
        legacyPack: 'canvas.write',
        title: '开始生成',
        description:
          'Start generating from the selected Canvas exactly as it is now. Returns immediately with a job id; call it once per request and do not wait for the picture. Generation fails while the Canvas still has problems.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.runs.generate'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['run'],
        policyFloor: 'auto',
        requires: ['editable'],
        headless: 'requires-ui',
        summarize: () => '按当前画面生成',
      },
      {
        id: 'studio.runs.cancel',
        title: '取消生成',
        description: 'Cancel an active generation job by explicit `jobId` or the active job on a Canvas.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.runs.cancel'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['run'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => (text(args.jobId) ? `取消任务 ${short(text(args.jobId), 16)}` : '取消当前生成'),
      },
      {
        id: 'studio.runs.pin',
        title: '固定结果到画板',
        description: 'Pin a folded filmstrip result as its own card on the board.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.runs.pin'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => `固定结果 ${short(text(args.runId), 16)}`,
      },
      {
        id: 'studio.runs.unpin',
        title: '收回结果到胶片条',
        description: 'Fold a pinned result back into its source layout filmstrip when no other canvas depends on it.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.runs.unpin'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => `收回结果 ${short(text(args.runId), 16)}`,
      },
      {
        id: 'studio.runs.apply_settings',
        title: '套用历史生成设置',
        description:
          'Copy description, regions, size, model, quality, locked seed, sampling and LoRA from a run back onto its layout Canvas.',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.runs.apply_settings'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['write'],
        policyFloor: 'auto',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => `套用 ${short(text(args.runId), 16)} 的设置`,
      },
      {
        id: 'studio.runs.drop',
        title: '删除胶片条运行',
        description: 'Remove an unpinned run from a layout filmstrip (generated picture stays in Library).',
        inputSchema: STUDIO_ACTION_SCHEMAS['studio.runs.drop'],
        target: 'renderer',
        scope: 'project',
        surface: '/studio',
        effects: ['delete'],
        policyFloor: 'approval',
        requires: [],
        headless: 'requires-ui',
        summarize: (args) => `移除运行 ${short(text(args.runId), 16)}`,
      },
    ],
    contexts: [],
    skills: [
      {
        id: 'studio.skill.runs',
        requiresActions: ['studio.runs.generate'],
        order: 60,
        audience: ['tools', 'resources'],
        markdown: [
          '## Generation and Filmstrip Runs',
          '- Clear all reported `problems` before calling `studio_generate`.',
          '- `studio_generate` returns immediately with a job id; do not loop waiting for completion.',
          '- Removing a run from the filmstrip (`studio.runs.drop`) requires approval.',
        ].join('\n'),
      },
    ],
  },
]

/** Create a fresh registry pre-loaded with all built-in Studio capability packs. */
export function createStudioCapabilityRegistry(): CapabilityRegistry {
  return createCapabilityRegistry(STUDIO_CAPABILITY_PACKS)
}
