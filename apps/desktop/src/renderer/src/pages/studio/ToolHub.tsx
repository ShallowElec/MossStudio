import { useState } from 'react'
import { Plus } from 'lucide-react'
import { MenuItem, Popover } from '../../components/common/Popover'
import { FieldLabel, IconButton } from '../../components/ui'
import { boardTools } from './builtinBoardTools'
import type { BoardCommand, ToolContext, ToolGroup } from './toolRegistry'

const groups: Record<ToolGroup, string> = { node: '添加节点', recipe: '工作流配方', picture: '画面工具' }

export function ToolHub({ context, execute }: { context: ToolContext; execute: (command: BoardCommand) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
      onWheelCapture={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // Delete and Backspace must not remove cards behind an open picker; Ctrl+Z, Ctrl+S and the rest still reach the board.
        if (open && (event.key === 'Delete' || event.key === 'Backspace')) event.stopPropagation()
      }}
    >
      <Popover
        open={open}
        onOpenChange={setOpen}
        label="工具与节点"
        className="w-64 max-h-[min(70vh,32rem)] overflow-y-auto"
        trigger={({ open, toggle, ...aria }) => (
          <IconButton label="工具与节点" aria-pressed={open} onClick={toggle} {...aria}>
            <Plus className="size-4" strokeWidth={1.6} />
          </IconButton>
        )}
      >
        {(close) => {
          const entries = boardTools.list('hub', context)
          return (Object.keys(groups) as ToolGroup[]).map((group) => {
            const items = entries.filter(({ tool }) => tool.group === group)
            return items.length ? (
              <div key={group} role="group" aria-label={groups[group]}>
                <FieldLabel className="px-2.5 pt-2">{groups[group]}</FieldLabel>
                {items.map(({ tool, state }) => {
                  const note = state.kind === 'disabled' ? state.reason : state.kind === 'ready' ? state.hint : undefined
                  return (
                    <MenuItem
                      key={tool.actionId}
                      title={note ?? tool.description}
                      hint={note}
                      disabled={state.kind === 'disabled'}
                      onSelect={() => {
                        if (boardTools.invoke(tool.actionId, context, execute)) close()
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <tool.icon className="size-4" strokeWidth={1.6} />
                        {tool.label}
                      </span>
                    </MenuItem>
                  )
                })}
              </div>
            ) : null
          })
        }}
      </Popover>
    </div>
  )
}
