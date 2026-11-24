import { GalleryHorizontal, ScanLine, ScanSearch, Workflow } from 'lucide-react'
import { PARSE_CHECKING } from '@shared/gbc'
import { nodeRegistry } from './nodeRegistry'
import { RECIPES } from './recipes'
import { createToolRegistry, type Availability, type BoardAction } from './toolRegistry'

const ready = (): Availability => ({ kind: 'ready' })
const hidden: Availability = { kind: 'hidden' }
const disabled = (reason: string): Availability => ({ kind: 'disabled', reason })

export const boardTools = createToolRegistry([
  ...nodeRegistry.map(({ nodeId, label, icon, description }, i): BoardAction => ({
    actionId: `node.${nodeId}`,
    slot: 'hub',
    group: 'node',
    order: i,
    label,
    icon,
    description,
    command: { type: 'create', node: nodeId },
    availability: ready,
  })),
  {
    actionId: 'image.gallery',
    slot: 'hub',
    group: 'node',
    order: 10,
    label: '从作品选择…',
    icon: GalleryHorizontal,
    description: '把作品里的图片放到画布上',
    command: { type: 'gallery' },
    availability: ready,
  },
  ...RECIPES.map((recipe, i): BoardAction => ({
    actionId: `recipe.${recipe.id}`,
    slot: 'hub',
    group: 'recipe',
    order: 20 + i,
    label: recipe.label,
    icon: Workflow,
    description: recipe.hint,
    command: { type: 'recipe', recipe: recipe.id },
    availability: (ctx) => {
      const current = ctx.recipes.find((item) => item.id === recipe.id)
      return !current ? hidden : current.disabled ? disabled(current.disabled) : ready()
    },
  })),
  {
    actionId: 'gbc.open',
    slot: 'hub',
    group: 'picture',
    order: 40,
    label: '解析',
    icon: ScanSearch,
    description: '打开解析面板，查看图片的描述和区域',
    command: { type: 'openGbc' },
    availability: (ctx) => (ctx.parseBlocker === undefined ? hidden : ready()),
  },
  {
    actionId: 'gbc.split',
    slot: 'hub',
    group: 'picture',
    order: 41,
    label: '拆成区域',
    icon: ScanLine,
    description: '把所选图片拆成带描述的区域',
    command: { type: 'split' },
    // As in the card menu: only 正在检查 turns it off; another blocker shows and choosing it leads to 设置.
    availability: (ctx) =>
      ctx.parseBlocker === undefined
        ? hidden
        : !ctx.pictureId
          ? disabled('先选择一张有图片的卡片')
          : ctx.parseBlocker === PARSE_CHECKING
            ? disabled(PARSE_CHECKING)
            : { kind: 'ready', hint: ctx.parseBlocker ?? undefined },
  },
])
