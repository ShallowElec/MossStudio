---
status: current
last-verified: 2026-11-21 (e72b798)
code: apps/desktop/src/shared/capabilities/, apps/desktop/src/main/capabilities/, apps/desktop/src/main/mcp/, apps/desktop/src/main/agentHub/, apps/desktop/src/main/externalAgents.ts, apps/desktop/src/main/services/imageEdit.ts, apps/desktop/src/renderer/src/lib/capabilities/, apps/desktop/src/renderer/src/lib/agentTools.ts, apps/desktop/src/renderer/src/pages/studio/studioCapabilities.ts, apps/desktop/src/renderer/src/pages/studio/assistant/, tools/mcp/mossstudio-mcp-stdio.mjs
---

# External Agents

How an external Agent (Codex, Claude Code, any MCP client) uses MossStudio: a loopback MCP server over a capability registry, the 协同 panel beside the 助手, and the approvals a person answers. All of it is behind 设置 › 功能 › 外部 Agent, off by default; the built-in 助手 does not use any of it. The reasons are in [ADR-0016](/docs/decisions/0016-external-agents-over-mcp.md).

Paths are relative to `apps/desktop/src/`.

## 1. The switch

`Settings.externalAgentsEnabled` (`shared/types.ts`, default `false`) gates everything here. `main/externalAgents.ts` reads it; `syncExternalAgents` in `main/ipc.ts` runs at start and whenever the setting changes.

| Off | On |
| --- | --- |
| No MCP server and no `<dataRoot>/mcp-server.json`; nothing is written to `<dataRoot>/mcp/` (a bridge copy and `clients.json` from an earlier time on stay) | The server listens and writes its discovery file; eligible registrations are refreshed (`refreshMcpClientRegistrations`, section 7) |
| Every `agent-hub:*`, `capabilities:*` and `mcp:*` channel answers `E_FEATURE_OFF` (`handleExternal`) | The channels answer; the profiles never include the ask cards (`studio.ask`, `MCP_EXCLUDED_PACKS`), which only the 助手's chat shows |
| No 协同 button in the 助手, no approval overlay (`App.tsx`) | Both show |
| Turning it off stops the server, deletes the discovery file, ends every ACP child and drops waiting approvals | |

## 2. The capability registry

`shared/capabilities/` describes each action once: a dotted id (`studio.cards.create`), its pack, target (`main` or `renderer`), effects, policy floor (`auto`, `approval`, `human-only`), zod input schema and a one-line summary. `protocol.ts` holds `MUTATING_EFFECTS` (`write`, `run`, `delete`, `export`, `install`, `configure`), the one list main, the renderer and the MCP annotations use. Packs with a `featureFlag` (`remote.hosts`, `studio.gbc.parse`, `training.jobs`, `image.edit`) are invisible while that switch in 设置 › 功能 is off. `image.edit` (外接重绘) needs two switches, 外接重绘 (`externalImageEditEnabled`) and 外部 Agent, because its action is the first that uploads a local file to a third party (`capabilityFlags` in `main/capabilities/builtinHandlers.ts`). A Studio action that supersedes a 助手 tool names it in `legacyAlias` and reuses its schema from `shared/agent/schemas.ts`.

`projectCapabilities` (`profiles.ts`) projects a toolset per profile: `compact` (the packs in `COMPACT_PROFILE_PACKS`), `moss-standard` and `moss-layout` (`MOSS_STANDARD_PROFILE_PACKS`, `MOSS_LAYOUT_PROFILE_PACKS`), `atomic` (everything enabled), `proposal-only` (no mutating action) and `custom` (chosen packs).

Two packs carry only a guide and no actions: `skill.moss.standard` (描述写法指南) and `skill.moss.layout` (分区构图指南), in `appPacks.ts`. The active Skill includes a guide only when its pack is named in the enabled packs: by `moss-standard`, by `moss-layout` (both guides), or ticked in `custom`. `compact`, `atomic` and `proposal-only` never include them (`GUIDE_ONLY_PACKS` in `registry.ts`). While one is on, the 协同 panel also adds a short summary of it to each message (`toolProfileLine` in `CollabToolbar.tsx`). The built-in 助手 does not use either.

## 3. The MCP server

`main/mcp/server.ts`: Streamable HTTP on `127.0.0.1` with an ephemeral port and a random 256-bit bearer token, written with the URL to `<dataRoot>/mcp-server.json` (mode 0600).

| Rule | Where |
| --- | --- |
| Every request needs the bearer token, `/health` too | `constantTimeBearerMatch` |
| A request with an `Origin` header, or whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`, gets 403 | `isLoopbackHost` |
| `initialize` answers with the client's protocol version when it is in `MCP_SUPPORTED_VERSIONS`, else `2025-03-26` | `handleRpc` |
| `tools/call` runs only what `tools/list` offered for the active profile (`allowed`) | `handleRpc`, `dispatcher.execute` |
| A call still waiting when the client hangs up is aborted: its approval is dropped and nothing runs | `res.once('close')` |
| Wire names encode dots as `__` (`studio__cards__create`) | `toMcpToolName` |

Resources: the active Skill, the promptcraft and layout guides, the workbench context and `mossstudio://audit/recent` (external Agents' calls only). The two guides in `shared/capabilities/officialSkills.ts` are adapted from the MOSS-Image prompt-enhancer skill (Apache License 2.0) and say so. `composeOfficialGuide` adds each guide to the full guide once, after the active Skill, whether or not its pack is on.

## 4. The dispatcher

`main/capabilities/dispatcher.ts` `execute` checks, in order:

1. The action exists; an unknown name is still audited.
2. It is in the caller's `allowed` set (the MCP profile).
3. Its pack's feature switch is on.
4. It is not `human-only`; a `readOnly` caller (the 协同 panel's own IPC) may only run non-mutating `auto` actions.
5. Its input passes the schema; `prepareArgs` then checks every file it names (`main/capabilities/agentPaths.ts`): a local PNG, JPEG, WebP or BMP inside a 作品 folder or a project, by its real path. A network path or a link to one is refused without being opened (`lib/localPath.ts`).
6. In 审批 (`mode: 'advanced'`, or the `proposal-only` profile) a mutating action returns `{ proposed }` and changes nothing.
7. An `approval` action waits for the person (section 6). `approvalDetail` adds what a training run will really use: its recipe and computer.
8. A `renderer` action goes to the Studio window, a `main` action to its handler in `builtinHandlers.ts`.

Every call is audited (`main/capabilities/audit.ts`): one JSON line in `<dataRoot>/logs/capabilities.jsonl`, written off the main thread, rotated to `.1` at 2 MiB, with summaries and errors capped at 200 characters. After a restart the last 256 KiB are read back.

Actions an external Agent may only run after a yes include deleting projects, series, trainings and models, moving 作品 to the trash, installing and downloading models, saving a 漫画, changing or stopping a training, writing captions, cancelling a job, switching 运行位置, every 看图拆区域 action and `image.edit.run`, which uploads a project or 作品 picture to a 外接重绘 channel (`policyFloor` in `shared/capabilities/appPacks.ts`). Its approval names the channel's origin and model; the upload is refused when either switch, the channel or the picture changed after the yes (`bindImageEdit` and `runImageEdit` in `main/services/imageEdit.ts`). Job ids are checked against `^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$` and must name a job the supervisor knows before any log or review file is read.

## 5. In the Studio

`runToolInStudioWindow` (`main/ipc.ts`) sends the call as `Events.aiToolCall` with `external: true`. The app shell's `installExternalToolBridge` (`renderer/src/lib/agentTools.ts`) takes it: when the Studio is not mounted it opens `/studio` and waits up to 8 seconds, else it tells the Agent the 创作页 is not open. `runExternalToolCall` runs a capability that supersedes a 助手 tool through that tool's handler, and any other through `RENDERER_CAPABILITY_HOST` (`renderer/src/lib/capabilities/host.ts`), where `studioCapabilities.ts` registers the Studio's handlers while the page is mounted. The 助手's own calls (no `external`) go to `installStudioToolBridge` and its executor, unchanged.

Each external call is one undo step, 外部 Agent 的修改, also for what it changes after an await (`createExternalSteps` in `pages/studio/useStudioProject.ts`). The board then shows the card the Agent added or selected, with a toast (`externalFocusOf`).

## 6. Approvals

`main/agentHub/approvalQueue.ts` holds requests for the person. A request waits `APPROVAL_WAIT_MS` (120 seconds) and is then rejected; one caller may have `MAX_PENDING_PER_SOURCE` (5) waiting, more are rejected at once. Without an open window nothing is approved. The 协同 panel shows the waiting requests above its input (`ApprovalDock.tsx`); on any other page `GlobalApprovalOverlay.tsx` shows them.

## 7. Connecting a client

`main/mcp/clientInstaller.ts` registers the stdio bridge (`tools/mcp/mossstudio-mcp-stdio.mjs`, copied to `<dataRoot>/mcp/` so it outlives updates) with the clients' own CLIs, run without a shell (`.cmd` shims through `resolveAcpLaunch`):

| Client | Register | Remove | Tool timeout |
| --- | --- | --- | --- |
| Claude Code | `claude mcp add-json --scope user mossstudio <json>` | `claude mcp remove --scope user mossstudio` | Client default; no `timeout` field is added |
| Codex | `codex mcp add mossstudio --env MOSSSTUDIO_MCP_DISCOVERY=… -- <command> <bridge>` | `codex mcp remove mossstudio` | `tool_timeout_sec` written into `[mcp_servers.mossstudio]` (`setCodexToolTimeout`): `codex mcp add` has no option for it |

The Codex tool timeout is `CLIENT_TOOL_TIMEOUT_SEC` (180 seconds), longer than an approval waits. `setCodexToolTimeout` follows a symlink to the real file, keeps its mode, keeps one `.mossstudio-backup`, and leaves the file alone when `mossstudio` is defined inline, dotted or twice. The bridge runs with the person's `node` when there is one, else with this app and `ELECTRON_RUN_AS_NODE=1`. Registrations are recorded in `<dataRoot>/mcp/clients.json`: a new app version registers them again with its own path, and uninstalling the app removes only those (`uninstallRecordedMcpClients`). Registration and removal first compare the live stdio command, arguments and environment against this instance's current or recorded launch; a recorded launch of the bundled bridge (when copying it to `<dataRoot>/mcp/` failed) still counts as this instance's. A missing CLI leaves the cleanup record intact. Background refresh skips an owned Codex entry if the service is disabled, has an `enabled_tools` list (even an empty one, which allows no tool) or has a nonempty `disabled_tools` list. Reconnecting it from the dialog requires confirmation because Codex re-enables the service and clears those lists. The dialog copies the same absolute launch, never a guessed `node`. For DeepSeek Harness it checks the `DSH_HOME` directory (default `~/.dsh`) and offers a stdio entry with `serverName: mossstudio` and `toolCallTimeoutMs` of the same `CLIENT_TOOL_TIMEOUT_SEC` (180000) for manual configuration; only DSH saves it.

The bridge forwards each JSON-RPC line to the server; requests after `initialize` run side by side, and `notifications/cancelled` (a client's own timeout) aborts the matching request. While no MossStudio is listening it answers `initialize`, `ping` and the list methods itself with an empty catalog, and from `notifications/initialized` on it polls `/health` (every 1.5 s, less often while offline), sending `notifications/*/list_changed` when the server, profile or tools change. A request MossStudio did not answer in time, or whose connection dropped, gets error -32002, which says it may still have run instead of asking for a retry.

## 8. The 协同 panel

`pages/studio/assistant/CollabPanel.tsx`, opened with 协同 in the 助手's header, talks to an ACP Agent (`main/agentHub/acpDriver.ts`): Codex ACP, or a command the person enters; or to DSH Desktop (below). `session/new` and `session/load` attach the MCP server (HTTP when the Agent supports it, else the stdio bridge). An Agent that advertises `loadSession` and `sessionCapabilities.list` keeps its conversations across a restart: they are listed with `session/list` and loaded again on first use, history replayed without being streamed as new text. For any other Agent a project's conversation list lasts for this run only (`setSessionsResumable` in `sessionBindings.ts`). A turn that streams nothing for 10 minutes is cancelled. Pictures go to the Agent inline in the prompt; nothing is written to disk.

Codex ACP is the default for someone who never picked an Agent; DSH Desktop is the default only when Codex ACP is not installed and DSH Desktop is running (`backends` in `main/agentHub/hub.ts`).

### DSH Desktop

`main/agentHub/dshDriver.ts` talks to a DeepSeek Harness desktop app running on this computer. It never contacts anything but loopback.

| Step | What runs | Rule |
| --- | --- | --- |
| Find the app | Windows: `powershell.exe` (`Get-Process`, `Get-NetTCPConnection`). macOS and Linux: `ps -A -o pid=,comm=`, then `lsof` on the app's own pids. On Linux, where `comm` is cut to 15 characters, the name is confirmed with `/proc/<pid>/exe` | No shell, 6-second timeout, ended on disconnect (`dshDiscovery.ts`). Only listeners on `127.0.0.1` or `::1` count |
| Pick the pairing address | The address the person pastes, else `MOSSSTUDIO_DSH_PAIRING_URL`, else `<dataRoot>/dsh-desktop-live.json` (`{ version: 1, pid, pairingUrl }`) | The file is used only when it is a regular file of at most 4 KiB with one link, not a symlink or on a network path, on macOS and Linux owned by this user with mode `0600` or stricter, unchanged between check and read, and its `pid` and origin match a found listener (`pairingFor`) |
| Pair | `GET /connect` on the found listener, then one WebSocket (`/api/remote.mux`) and `POST /api/<method>` calls | The address must be `http://127.0.0.1`, `[::1]` or `localhost` with a `token`, and belong to a found listener (`pairDesktop` in `dshPeer.ts`). Redirects are not followed; replies are capped at 16 MiB; pairing and calls time out after 15 seconds |

Conversations are grouped by DSH workspace (`agent-hub:projects`). After a connection drops, the driver looks for the app again at most every 10 seconds and pairs again by itself unless the person pasted the address or disconnected. Pictures in its messages are shown only when they are inline PNG, JPEG or WebP; main decodes and checks each one once and keeps its hash, since the panel polls the same history every few seconds. The panel never loads an image URL or path from a reply (`replyImages` in `CollabPanel.tsx`).

## 9. Tests

`test/main/capabilities/security.test.ts` and `dispatcher.test.ts` (allowlist, approvals, paths, audit), `test/main/mcp/server.test.ts` (Origin, Host, versions, profile, hang-up), `test/main/mcp/clientInstaller.test.ts`, `test/main/services/imageEdit.test.ts` (外接重绘's switches and approval boundaries), `test/main/agentHub/`, `test/main/ipc/` (the switch, and the 助手's 13 tools), `test/tools/mcp/stdioBridge.test.mjs`, `test/renderer/studio/studioCapabilities.test.ts`, `collabPanel.test.ts`, `sessionBindings.test.ts`; end to end `apps/desktop/e2e/specs/externalAgents.e2e.ts`, `imageEdit.e2e.ts` and the 协同, approval and MCP stops of `visual.e2e.ts`.
