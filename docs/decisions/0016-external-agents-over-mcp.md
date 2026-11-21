---
status: proposed
date: 2026-11-21
---

# ADR-0016: External Agents use MossStudio over MCP through a capability registry

## Context and problem statement

People who already work with a coding Agent (Codex, Claude Code, any MCP client) want it to draw in MossStudio: create 画面, write descriptions, set LoRA and start runs on the open board, and see the results. The built-in 助手 ([studio-assistant.md](../reference/studio-assistant.md)) has 13 tools for the selected 画面, mounted by `resolveToolset` in `apps/desktop/src/shared/agent/registry.ts`; an external Agent needs more of the app (projects, models, 作品, training, jobs) and reaches it from another process. PR #124 added a capability registry that describes about 80 actions once, a loopback MCP server over it, an ACP sidebar (协同) and a stdio bridge for MCP clients. The question: how do external Agents reach the app, and does the 助手 move onto the same registry?

## Decision drivers

- The 助手 is shipped and documented: its tools, `TOOL_RULES`, plans, one undo step per turn and 质量 snapping must not change as a side effect.
- An external Agent acts on a person's files, projects and GPU from outside the app: every change it makes needs an allowlist, approval for anything destructive, path rules and an audit trail.
- Most people never connect an Agent. Nothing of this may run, listen or write files for them.
- One description of each action should serve the tool list, the input schema, the approval preview and the Skill an Agent reads.

## Considered options

1. Expose the 助手's 13 tools over MCP and nothing else.
2. A capability registry (`apps/desktop/src/shared/capabilities/`) behind a loopback MCP server, used by external Agents only; the 助手 keeps `lib/agent`.
3. The same registry, with the 助手 moved onto it as well.

## Decision outcome

Chosen option: 2. Option 1 is too small for what Agents are asked to do (projects, models, runs). Option 3 changed the 助手's behaviour in PR #124 (80 tools instead of 13, plans that broke on new tool names, edits outside the turn's undo step, exact steps instead of 质量 presets), so it waits for its own decision.

As built:

1. **Opt-in.** 设置 › 功能 › 外部 Agent (`Settings.externalAgentsEnabled`) is off by default and for settings files written before it existed. Off, the MCP server does not start, no discovery file or bridge copy is written, every MCP, capability and 协同 IPC channel answers `E_FEATURE_OFF`, and the 协同 button and approval overlay are not shown. Turning it off stops the server, removes the discovery file and ends Agent processes.
2. **Registry for external Agents only.** The registry serves the MCP server and the read-only guide the 协同 panel shows. The 助手 keeps its own tools and executor exactly as before; an external call reaches the Studio marked `external` and takes the capability path, as one undo step 外部 Agent 的修改.
3. **Boundaries in main.** `dispatcher.execute` refuses any action outside the active MCP profile, validates input, checks file paths an Agent names (local pictures in 作品 or a project, never a network path), asks the person before destructive actions whatever the mode, and audits every call. Details are in [external-agents.md](../reference/external-agents.md).
4. **Clients through their own CLIs.** Codex and Claude Code are registered with `codex mcp add` and `claude mcp add-json`, run without a shell; MossStudio edits a client's file only for Codex's `tool_timeout_sec`.

### Consequences

- Good: the 助手 is unchanged, and people who never use an external Agent run nothing new.
- Good: one registry describes each action for the tool list, validation, approval and the Skill.
- Bad: two tool descriptions exist for the board's core edits (the 助手's `TOOL_SCHEMAS` and the registry, which reuses them through `legacyAlias`) until a later decision unifies them.
- Bad: the registry is large (15 packs) and grows with every feature an Agent should reach.

## More information

- PR #124, by BoltBlue121, which designed the registry, the MCP server, the 协同 panel, LoRA trigger words and Worker hosts; the maintainer's follow-up commits on the same PR made them opt-in and closed the review findings.
- [external-agents.md](../reference/external-agents.md) describes the result; [studio-assistant.md](../reference/studio-assistant.md) the unchanged 助手.
- MCP specification: https://modelcontextprotocol.io/specification. Agent Client Protocol: https://agentclientprotocol.com.
