import type { LucideIcon } from 'lucide-react'
import type { CreatableNodeId } from './nodeRegistry'
import type { Recipe, RecipeId } from './recipes'

export type BoardCommand =
  { type: 'create'; node: CreatableNodeId } | { type: 'gallery' | 'openGbc' | 'split' } | { type: 'recipe'; recipe: RecipeId }

export interface ToolContext {
  recipes: readonly Recipe[]
  pictureId: string | null
  /** Undefined when GBC is off; null when installed and ready. */
  parseBlocker: string | null | undefined
}
/** `hint` on a ready tool says what stands in the way; choosing it then leads to the fix. */
export type Availability = { kind: 'hidden' } | { kind: 'disabled'; reason: string } | { kind: 'ready'; hint?: string }
export type ToolGroup = 'node' | 'recipe' | 'picture'
export interface BoardAction {
  actionId: string
  slot: 'hub'
  group: ToolGroup
  order: number
  label: string
  description: string
  icon: LucideIcon
  command: BoardCommand
  availability: (ctx: ToolContext) => Availability
}

/** Static composition: importing a contribution cannot execute a tool or register IPC. */
export function createToolRegistry(contributions: readonly BoardAction[]) {
  const actions = [...contributions].sort((a, b) => a.order - b.order)
  const byId = new Map(actions.map((tool) => [tool.actionId, tool]))
  if (byId.size !== actions.length) throw new Error('Duplicate board action ID')
  return {
    list(slot: BoardAction['slot'], ctx: ToolContext) {
      return actions
        .filter((tool) => tool.slot === slot)
        .flatMap((tool) => {
          const state = tool.availability(ctx)
          return state.kind === 'hidden' ? [] : [{ tool, state }]
        })
    },
    invoke(id: string, ctx: ToolContext, execute: (command: BoardCommand) => void): boolean {
      const tool = byId.get(id)
      if (!tool || tool.availability(ctx).kind !== 'ready') return false
      execute(tool.command)
      return true
    },
  }
}
