---
status: proposed
date: 2026-11-22
---

# ADR-0017: Register Studio nodes and workbench actions in source

## Context and problem statement

The board already supports several ways to start a picture, and its menus know where a person clicked. Adding a top-level button for each workflow would crowd the canvas. GBC also needs both a parser panel and a command that acts on a particular picture; these are not the same operation. The question: how do new board tools become discoverable without changing saved projects, starting services or granting new Agent permissions?

## Decision drivers

- Preserve the existing toolbar, context-menu order and click position, starter row, shortcuts and undo steps.
- Describe new tools once, while letting selection, engine support and feature settings determine what works now.
- Keep UI variants distinct from the stored canvas kind, and local actions distinct from authority to call external tools.

## Considered options

1. Bespoke buttons and handlers per feature.
2. Typed descriptors composed in source, exposed through a single optional picker.
3. Plugins discovered at runtime, or a picker generated from MCP capabilities.

## Decision outcome

Chosen option: 2. Option 1 is small for one action but duplicates availability and history rules across entry points. Option 3 needs a trust and lifecycle model for plugins, and generating the picker from MCP capabilities conflates a person's board gestures with external authorization; neither is needed for in-tree tools.

As built:

1. **Node registry.** [`nodeRegistry.ts`](/apps/desktop/src/renderer/src/pages/studio/nodeRegistry.ts) lists only the nodes the picker can create directly (新建画面, 新建风格, 导入图片…). Its IDs (`CreatableNodeId`) determine which creation commands the board must handle; the remaining fields supply the menu label, icon and description. Upscaling starts from a picture or recipe, and only a run produces a result. The registry does not define ports or persisted kinds.
2. **Board actions.** [`builtinBoardTools.ts`](/apps/desktop/src/renderer/src/pages/studio/builtinBoardTools.ts) contributes each action with a slot, group, order and command; [`toolRegistry.ts`](/apps/desktop/src/renderer/src/pages/studio/toolRegistry.ts) composes them statically and refuses duplicate IDs. The picker (`ToolHub.tsx`, 工具与节点) delegates to the same project callbacks as the context menu and starter row (`executeHubCommand` in `Board.tsx`). It does not synthesize a right-click or open another undo transaction. `toolHubEnabled` (设置 › 功能 › 工具与节点管理器) is off by default and changes only discovery; it never enables GBC.
3. **Visibility, executability and authorization are separate.** Hidden actions are omitted; disabled ones explain what is missing, and a ready one may carry a hint that choosing it leads to the fix. Dispatch checks availability again before running a command. A picker entry registers no tool with the 助手 or MCP and grants no permission; see [ADR-0016](/docs/decisions/0016-external-agents-over-mcp.md).
4. **One owner of the right sidebar.** The Studio holds one transient panel ID (`PanelId` in `StudioPanels.tsx`) or `null`. The 助手 is hidden, not removed, so switching to GBC or closing the sidebar does not discard an in-flight turn. GBC mounts only while selected and enabled; switching it off also clears its selection. Opening it from the picker or the title bar selects the same panel. The picker itself is transient and owns no project or chat state.

Not built: a 3D placement workflow. Before adding one, decide whether existing project data can represent its output, and add a picker entry only when a board operation implements it; a new persisted shape needs its own migration and review. API image editing shipped after this decision as 外接重绘 (PR #133), an action on a card's picture outside the picker.

### Consequences

- Good: new in-tree tools are discoverable in one stable place and reviewed with their commands.
- Good: built-in menus keep their context-specific behaviour; a new tool must opt into any additional surface explicitly.
- Good: people who never turn the switch on see no change.
- Bad: shipping a new contribution requires a build; third-party code loading is not part of this decision.
- Bad: each entry point still exists beside the picker, so a tool offered in both must keep its availability rule in one descriptor.

### Confirmation

`apps/desktop/test/renderer/studio/toolRegistry.test.ts` exercises identity, visibility, dispatch rejection, focus dismissal and panel lifetime. `apps/desktop/e2e/specs/toolHub.e2e.ts` covers the absent default trigger, the grouped picker, recipe undo and the 助手's unsent draft; the existing board, Studio, GBC and external Agent specs remain the compatibility checks.

## More information

- PR #132, by BoltBlue121, which added the picker and the registries; PR #156 leaves board shortcuts to the board while the picker is open.
- [studio-node-board.md](/docs/reference/studio-node-board.md) describes the board and its toolbar; [ADR-0011](/docs/decisions/0011-rail-navigation-and-node-board.md) the board itself.
