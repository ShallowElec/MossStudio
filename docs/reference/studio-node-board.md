---
status: current
last-verified: 2026-11-08 (fec4fe3)
code: apps/desktop/src/renderer/src/pages/studio/, apps/desktop/src/renderer/src/lib/preparation.ts, apps/desktop/src/shared/types.ts, apps/desktop/src/shared/canvasJobBranch.ts, apps/desktop/src/shared/cliEngine.ts, apps/desktop/src/shared/generationError.ts
---

# Studio node board

The Studio (创作, route `/studio`) is one free-form board per project. Cards are canvases of four kinds wired through typed ports, and every generation is a result that stacks in the filmstrip of its 画面 (`kind: 'layout'`) until it is pinned or used. This doc says what is built and where the code is; the assistant has its own doc, [studio-assistant.md](/docs/reference/studio-assistant.md), and the reasons are in [studio-design.md](/docs/explanation/studio-design.md).

Paths are relative to `apps/desktop/src/`; `studio/` stands for `renderer/src/pages/studio/`. Types are linked, not restated: the project file is [`ProjectDocument`](/apps/desktop/src/shared/types.ts) (`schemaVersion: 3`), a card is a `ProjectCanvas`, its pictures are `CanvasInputs`, and what an engine can do is `EngineFeatures`, all in the same file. Terms follow the [glossary](/docs/reference/glossary.md). The Rail, routes and windows are in [architecture.md](/docs/reference/architecture.md).

## 1. The page

| Area | Holds | Code |
| --- | --- | --- |
| Title bar | The project switcher and the 助手 toggle | `studio/ProjectSwitcher.tsx`, `studio/StudioPage.tsx` (`TitlebarPortal`) |
| Left sidebar 生成设置 | The selected card's settings: description, one line for 模型, 尺寸 and LoRA, 质量, 高级 (种子, 运行位置, 显卡, sampling), 输入, the regions list, and the 生成 button with its blockers | `studio/ParamsPanel.tsx`, `studio/InputsSection.tsx`, `studio/SamplingSection.tsx`, `studio/InspectorPanel.tsx` |
| Board 画布 | Cards, wires, the floating toolbar (选择 V, 平移 H, zoom 25 to 300 %, 适应窗口 F, 小地图), the minimap, the bar over picked cards and the right-click menus | `studio/Board.tsx`, `studio/Toolbar.tsx`, `studio/Minimap.tsx`, `studio/BoardMenu.tsx` |
| Right sidebar 助手 | The assistant, hidden until toggled and kept mounted so a running chat survives; see [studio-assistant.md](/docs/reference/studio-assistant.md) | `studio/assistant/Assistant.tsx` |

`studio/useStudioProject.ts` loads and saves the project; edits autosave after 1.2 s (`AUTOSAVE_DELAY_MS`). Keys: Ctrl+Enter generates, V / H / M pick a tool, Space held pans, F fits every card, Ctrl+A picks every card, Esc keeps only the selected card, and Delete removes the selected region or wire, else the picked cards (asking first).

## 2. Board and cards

- A card is drawn from its `x`, `y`, `width` and `height` in board pixels (`studio/boardLayout.ts`): `BOARD_UNIT` 0.25, so a 1024 px picture is a 256 px card; `CARD_HEADER` 28 px holds the title. Cards move by their title row or their picture (`studio/useCardDrag.ts`). A left drag on empty board draws a box that picks every card it touches; the right or middle button, Space held, or the 平移 tool pans, and a right-click that does not move still opens the menu; the wheel zooms around the pointer.
- Several cards can be picked at once (`studio/selection.ts`): a box, Shift, Ctrl or ⌘ clicks, or Ctrl+A. The picked cards are a `Board` state that counts only while it holds the selected card (`selectedCanvasId`, which the left panel shows), so selecting a card any other way picks it alone; nothing about picking is saved. Picked cards move together and get a bar with 已选 N 张, 排整齐 (`tidyPlaces`: rows of about √n from the group's corner) and 删除, which asks once; Delete does the same, Esc keeps only the selected card. The minimap (`studio/Minimap.tsx`) draws every card, the picked ones in the accent and running ones with a dot, and the part on screen as a tint; a press or drag on it centres the view there. It shows by itself only while some card reaches past the part of the board on screen and the board is at least `MINIMAP_MIN_BOARD` (640 px) wide (`studio/selection.ts` `minimapHelps`); once the 小地图 button is used, the person's choice holds. It follows pans through `Board`'s view listeners rather than renders, and cards placed near the corner keep clear of it (`keepInView`).
- Gestures stay off React and off the project until they end: a pan sets the board's transform directly and commits the view on release, wheel ticks render at most once a frame, and a dragged card is drawn from `Board`'s own state and written to the project once, when it is let go. `CanvasCard` is memoized and compares its props by value (`sameCardProps`), so a new card prop must be plain data or a callback bound through `studio/useStableCallbacks.ts`; an inline closure would make every card re-render on every board render.
- Picture files (PNG, JPEG, WebP, BMP; `studio/imageNodes.ts`) dropped or pasted on the board become picture cards. They are copied into the project's assets through `Ipc.studioImportImage` (`studio/useBoardAssets.ts`), so an unsaved project is saved first.
- Deleting a card removes the wires that point at it and reports how many (`studio/links.ts` `dropLinksTo`); a 画面 takes its folded runs with it (`studio/canvases.ts` `removedWith`). The dialog 删除画面？ says that generated pictures stay in 作品 (`/library`).

Right-click menus (`studio/BoardMenu.tsx`, entries built in `studio/Board.tsx`):

| On | Entries |
| --- | --- |
| Empty board 画板 | 新建画面, the picture recipes (section 7), 新建风格, 一组同风格的图, 导入图片…, 从作品选择…, 显示全部 |
| A card (same as its ⋯ button) | The picture actions of section 6; on a 画面 (not a 放大), 描图… and, while it has one, 不用描图; 复制 or 复制为新画面, 查看详情 (opens the Activity panel on the job), then 删除 / 删除风格 / 删除画面 |
| A wire 连线 | 断开连线 |
| A region 区域 | 改描述, 删除 |

## 3. Canvas kinds

| UI | `kind` | What it is | Created by | Code |
| --- | --- | --- | --- | --- |
| 画面 | `layout` | The editable node: description, regions, inputs, sampling. It generates. | 新建画面, a recipe, 复制为新画面, 用作起始图, a wire released on the empty board | `studio/canvases.ts` (`createLayoutCanvas`, `canvasFromPicture`, `copyAsLayout`) |
| 风格 | `style` | A description and LoRA that every 画面 wired to it generates with | 新建风格, the 风格 socket's 新建风格, recipe 一组同风格的图, 在创作中试用 on a finished training (section 10) | `studio/nodes.ts` (`createStyleCanvas`, `tryLoraOnBoard`) |
| 放大 | `layout` with `upscale` | A 画面 that redraws its 原图 at ×1.5 or ×2 | 放大 in a card's menu or the wire-drop menu, recipe 放大一张图 | `studio/nodes.ts` (`upscaleFromPicture`) |
| result (no label; it carries its 画面's title) | `result` | One run: its picture and the settings it was made with, pointing back through `sourceCanvasId` | Every run | `studio/canvases.ts` (`taskCanvasFor`), `studio/runs.ts` |
| picture card (原图 or 图片 in messages) | `image` | An imported file: `imagePath` and its pixel size `imageSize` | 导入图片…, 从作品选择…, drop, paste, 输入 › 添加 | `studio/canvases.ts` (`createImageCanvas`), `studio/useInputImport.ts` |

A result card is read-only: the panel shows its settings, 复制为新画面 makes an editable copy, and 重新生成 runs it again with the same settings and seed (`studio/readiness.ts` `rerunEligibility`). A 风格 card is 256 × 128 (`STYLE_CARD`) and shows its name and text; the panel (`StylePanel` in `studio/ParamsPanel.tsx`) edits 风格名称, 风格描述, LoRA and lists 用在, the 画面 that use it.

## 4. Ports and wires

Every card that has a picture, and every 风格, carries an output handle on the right edge of its body (`studio/CanvasCard.tsx`, `data-output-port`; `Board.tsx` sets `hasOutput`). A 画面 gives the picture shown on its face, so a wire from it points at that run (`studio/runs.ts` `pictureLink`). A 画面's input slots sit on its left edge, one chip each (`studio/ports.ts` `inputSlots`):

| Slot | Role (`LinkRole`) | Rule |
| --- | --- | --- |
| 起始图 | `init` | One. Offered when the engine has `imageInput`. |
| 控制 · 深度 / 边缘 / 姿态 | `control` | One per `controlKinds` of the chosen 控制适配器. Without an adapter a single 控制 slot says 先选择一个控制适配器, or 需要先添加控制适配器 when none is installed. |
| 参考图 | `reference` | Up to `MAX_REFERENCES` (4). |
| 风格 | `style` | Up to `MAX_STYLES` (3). Appears once the board has a 风格. |
| 原图 | `init` | A 放大's only slot. |

Slots of roles the engine cannot do are not offered; a link that already exists in such a role stays visible so it can be removed.

| Gesture | What happens | Code |
| --- | --- | --- |
| Drag from a handle | Every card that can take the picture shows its sockets; the wire snaps within `SNAP_RADIUS` (64 screen px); release links. A socket or card that refuses shows the reason in a bubble. | `studio/useWireConnect.ts`, `studio/ports.ts` (`dropZones`, `slotDrop`) |
| Click a handle | The wire follows the pointer; the next click places it; Esc or a right click cancels. | `studio/useWireConnect.ts` (`follow`) |
| Release on the empty board after pulling 48 px | Menu 新画面 · 起始图, 新画面 · 参考图, 放大 | `studio/connect.ts` (`newCanvasMenu`), `studio/LinkMenu.tsx` |
| Click an empty slot | Menu: the board's pictures as thumbnails, 从作品选择, 从文件…; on a 风格 slot 用「名字」 and 新建风格; on a 控制 slot without adapter, the adapters or 去添加控制适配器 | `studio/SlotMenu.tsx`, `studio/connect.ts` (`pictureSources`) |
| 输入 › 添加 in the panel | The same choices | `studio/InputsSection.tsx` |

Rules in `studio/connect.ts` (`canConnect`) and `studio/links.ts`: a card never feeds itself (不能连到自己); only a 画面 takes wires (只能连到可编辑的画面); a 风格 cannot feed a 放大; a link that would close a loop is refused (这样会连成一个圈; results and picture cards end a chain); a 风格 released anywhere on a 画面 lands in its 风格 socket (`styleDrop` words the refusal when it is full or already linked); replacing the 起始图's source drops the painted 遮罩.

Wires (`studio/wires.ts`, drawn by `studio/WireLayer.tsx`) are of two kinds: `input`, one per link, with a chip naming it (起始图 60%, 控制 · 深度, 参考 2, 风格 1), and `lineage`, the faint line from a 画面 to a result that became a card. A wire is removed by selecting it and pressing Delete, by 断开连线, or by the remove button of its row in 输入.

## 5. Inputs

| Input | Stored in | Settings | Sent as |
| --- | --- | --- | --- |
| 起始图 | `inputs.init` | 重绘幅度 0 to 1 (default `DEFAULT_INIT_STRENGTH` 0.6); 起始图缩放方式 crop / fit / stretch under 高级. A 画面 that has never run takes the shape of its first 起始图 at about the same pixel count, its regions scaled with it (`studio/nodes.ts` `withStartPictureShape`), so the picture is not cropped | `JobParams.initImage` |
| 遮罩 | `inputs.mask.path` | Painted on the 画面 with the 遮罩 tool (M): 画笔, 橡皮, 大小, 反转, 清除, 完成. White means repaint. Saved as a PNG in the project's assets. | `JobParams.mask`; needs a 起始图 |
| 控制图 | `inputs.control` | 控制适配器 (installed from 模型), its LoRA 强度, and per image 强度 0 to 10 (default 1) with 开始 and 结束 0 to 1 | `JobParams.control` |
| 参考图 | `inputs.references` | 参考图最长边 16 to 2048 | `JobParams.references` |
| 风格 | `inputs.styles` | None; merged at generation (section 10) | The prompt and `adapters` |

描图 (`backgroundPath`) is a picture from 作品 shown under a 画面 to trace over, chosen from the card's menu or 作品's 用作描图. It is a guide only and is never sent to the engine.

`studio/jobInputs.ts` (`resolveJobInputs`) turns each link into the source's file path and the adapter id into its file. Anything that cannot be resolved becomes a blocker; an input is never dropped quietly. `studio/mask.ts` maps the painted mask between canvas pixels and the start picture's pixels the way the engine's `resize_to` does, and `maskAvailability` hides the tool when the engine has no `imageInput` and disables it on a 放大 or a result.

## 6. Runs and the filmstrip

- A run (`studio/useGenerate.ts`) resolves the 画面 with its 风格 nodes (`generationCanvas`), resolves inputs, picks the seed (`studio/defaults.ts` `seedForRun`: a new random seed unless 种子 is locked), and writes into a new result canvas (`taskCanvasFor`). The 画面's face follows the newest run.
- The filmstrip (`studio/runs.ts`, `studio/Filmstrip.tsx`) lists every run of a 画面, oldest left. A run stays folded in the strip unless it is pinned, feeds another canvas, or is itself the source of a result (`foldedRunIds`). Click a thumbnail to show it on the face (and on the wires), double-click to open the viewer (`studio/OutputViewer.tsx`), drag it onto the board to pin it where it lands (`studio/useRunDrag.ts`). Runs that do not fit sit behind +N. A run without a picture (running, 失败, 停止) shows only while it is the newest; the next run clears such leftovers (`staleRunIds`). A finished card reads N 张, then 排队 N 张 when jobs were ahead of it and 实跑 with the engine's own time (`studio/jobStatus.ts`, from `JobRecord.queuedBehind` and `runStartedAt`).
- A failed run says what happened in plain words, from the code the engine returned (`shared/generationError.ts`); the engine's own text stays in the job log, behind 查看详情 (on the face of a 画面, in the footer of a result). Out of GPU memory (`E_OOM`) reads 显存不够这个尺寸, and 重试, which would fail the same way, becomes 改小一点再试: the 画面 goes one size step down (`smallerSize` in `studio/defaults.ts`, about half the pixels, regions scaled along by `smallerCanvas`) and runs again. A 放大, whose size comes from its start picture, and a 画面 already at the smallest size keep 重试. The same words show in 活动 and the failure notification, and in 漫画's retry line.
- Busy branches (`shared/canvasJobBranch.ts`): while a job is active, its canvas and every canvas upstream in its `sourceCanvasId` chain count as busy, so 生成 and 重新生成 are disabled with 这个画面或它的结果正在生成. Main checks the same lineage before starting a job.

Picture actions in a card's menu (`studio/Board.tsx` `cardActions`):

| Entry | Does | Code |
| --- | --- | --- |
| 用作起始图 | A new 画面 to the right, fed by this picture; it takes the settings, description and regions | `studio/canvases.ts` (`canvasFromPicture`) |
| 拆成区域 | A new 画面 to the right, shaped like the picture and not wired to it, that fills with the regions and description KohakuGBC finds. Offered while 看图拆区域 is on; while it is not installed, the entry names why and leads to 设置 › 功能. With no model that sees pictures it stays as it is, and choosing it asks for one (拆成区域要用语言模型) and then reads | `studio/pictureRegions.ts`, `studio/usePictureRegions.ts` |
| 放大 | A 放大 node fed by this picture; offered while the engine has `imageInput` and the long edge is under 2048 | `studio/nodes.ts` (`upscaleFromPicture`) |
| 固定到画板 | A folded run becomes a card under its 画面 and stays in the strip | `studio/runs.ts` (`pinRun`) |
| 收回到「画面」 | A pinned result goes back into the strip, unless a canvas uses it | `unpinRun`, `canUnpin` |
| 用这次的设置 | The 画面 takes a run's description, regions, size, model, quality, seed (locked), sampling and LoRA | `withRunSettings` |
| 删除这次生成 | Removes a run that is only in the strip; its picture stays in 作品 | `dropRun`, `canDropRun` |

While 拆成区域 reads, the new 画面 shows the picture faintly with 正在看图… (or 正在下载看图模型 on the first run) and 停止 (`ParseOverlay` in `studio/CardStatus.tsx`). The regions arrive all at once, at most `GBC_MAX_REGIONS`, as 物体; a description typed meanwhile is kept. 停止, a failure, or deleting the 画面 ends the run, and a 画面 still untouched is taken away again. Setup and the main side are in [architecture.md](/docs/reference/architecture.md#gbc).

## 7. Recipes

A recipe lays out nodes already wired; nothing about them is special afterwards (`studio/recipes.ts`, started in `studio/StudioPage.tsx` `startRecipe`). They are offered in the empty board's menu and, while the project's only card is a 画面 with no inputs, regions or runs (a description may be typed; `starterCanvas`), in a row under it (`StartRow` in `studio/BoardControls.tsx`). A picture recipe asks for the file first, so a cancelled pick, or one that comes back after another project was opened, leaves the board as it was; that blank 画面 takes the picture rather than a second 画面 beside it, and the board brings the 画面 and its picture card into view. That same blank 画面 shows three descriptions to try on its face (`FIRST_IDEAS` in `studio/Board.tsx`); a click writes one as its description.

| `RecipeId` | Label | Lays out | Not offered when |
| --- | --- | --- | --- |
| `edit` | 改一张图 | A 画面 with a picture chosen from a file as 起始图 | no `imageInput` |
| `inpaint` | 局部重绘 | The same, then switches to the 遮罩 tool | no `imageInput` |
| `compose` | 按构图生成 | A 画面 with the first installed 控制适配器 and the picture as its first control kind | no `control`, or no 控制适配器 installed |
| `style` | 参考风格 | A 画面 with the picture as 参考图 | no `references` |
| `upscale` | 放大一张图 | A 放大 fed by the chosen picture | no `imageInput` |
| `series` | 一组同风格的图 | A 风格 and three 画面 wired to it, side by side (`studio/nodes.ts` `seriesFromStyle`) | never; needs no engine |

A recipe this computer cannot run is left out of the menu and the row, and the row is not shown when none is left (a text-only engine). While no engine is usable yet, the picture recipes are shown off with the engine's reason instead.

## 8. Readiness checks

`studio/readiness.ts` (`deriveReadiness`) lists what stands between the user and 生成. Only real blockers appear, each with the fix's location when it is elsewhere.

| `Blocker.id` | When | Action |
| --- | --- | --- |
| `update-required` | Main refuses jobs from this version (`E_UPDATE_REQUIRED`) | 更新 opens the update popover, or 查看 |
| `model-none`, `model-incomplete`, `model-missing` | No installed bundle; the bundle is still downloading; the canvas names a bundle the catalog lost | 去下载 (`/models`) |
| `model-engine` | A CLI engine and a bundle that is not a bf16 MOSS-Image bundle folder (`shared/cliEngine.ts` `cliBundleProblem`) | 去下载 |
| `engine` | The local engine is not ready or still installing (引擎正在安装 · N%) | 去准备 (`/setup`) before first-run setup is done, else 去设置 (`/settings/devices`) |
| `remote-path` | The chosen remote host has no model path | 去设置 |
| `adapters` | A LoRA on the canvas is not installed | 去模型库 |
| `remote-adapters`, `lora-unsupported` | LoRA with a remote host, or with an engine without `lora` | none; remove the LoRA |
| `input-source`, `input-adapter`, `input-unsupported`, `input-invalid` | From `resolveJobInputs` and `studio/nodes.ts` `nodeBlockers`: a source gone or not generated yet, a missing adapter, an input or sampling choice the engine lacks, a 放大 without 原图 or one that cannot grow | 去添加 for a lost adapter |
| `prompt` | The compiled prompt is invalid (`studio/prompt.ts` `compileCanvasPrompt`) | none |

Everything that needs the engine before 生成 (adding pictures, painting a mask, dropping a wire, a recipe) words its refusal with `engineUnavailableReason` from the same blockers, so the footer and the board never disagree.

While the first-run download is still running (`lib/preparation.ts`, `lib/usePreparation.ts`), the 生成 button itself fills up and reads 下载完成后就能生成 · N%, and the blockers that download will clear (`model-none`, `model-incomplete`, `engine`; `PREPARING_BLOCKERS` in `studio/StudioPage.tsx`) are not listed.

## 9. What each engine hides

`EngineFeatures` is read per target, the canvas's GPU or remote host, through `Ipc.engineFeatures` (`studio/useEngineFeatures.ts`): `undefined` while reading (everything is offered), `null` when no engine is usable there (empty slots and rows are shown disabled with the reason).

| Flag off | Disappears |
| --- | --- |
| `imageInput` | The 起始图 slot and row, the 遮罩 tool, 放大, recipes 改一张图, 局部重绘, 放大一张图 |
| `control` | The 控制 slots and row, recipe 按构图生成 |
| `references` | The 参考图 slot and row, recipe 参考风格 |
| `lora` | 添加 in the LoRA section; rows already there stay so they can be removed |
| `hires`, `samplers` | 高清修复; 采样器 and 调度器 in 高级 |

The Studio does not read `preview`: a live preview shows on the card whenever the job carries one (`studio/jobStatus.ts`). CLI engines (兼容模式, `cli: 'vulkan'`; AMD 原生, `cli: 'hip'`) report every flag off (`shared/cliEngine.ts` `cliEngineFeatures`). The panel shows one note, `cliEngineNote` (这台设备用…引擎，只能文生图…), instead of the hidden rows; the sampler is fixed to euler with the moss schedule, and 步缓存 and CFG 截断 are refused. Remote hosts run `moss-server` over SSH with its full features except LoRA (`remote-adapters`); 运行位置 appears under 高级 only when `remoteHostsEnabled` is on. Engine packages, GPU choice and tiers are in [engines.md](/docs/reference/engines.md) and [ADR-0012](/docs/decisions/0012-vulkan-and-hip-cli-engines.md).

## 10. LoRA and the 风格 node

- LoRA rows (`LoraSection` in `studio/ParamsPanel.tsx`) exist on a 画面 and on a 风格. 添加 opens the adapter picker; each row has 强度 0 to 2 in steps of 0.05 (`shared/adapters.ts`), at most `ADAPTERS_PER_CANVAS_MAX` (16) per canvas. A row whose file is gone reads 找不到文件 and blocks 生成. LoRA files and import are in [models.md](/docs/reference/models.md).
- At generation (`studio/nodes.ts` `generationCanvas`) a 画面's description is followed by each wired 风格's, joined with "，", and its LoRA list by theirs; a LoRA the 画面 already has keeps the 画面's strength. The result records what it was really made with in `generated` (`generatedSnapshot`), so 重新生成 reproduces it; `styleLoraNote` names the 风格 in a LoRA blocker (其中有风格「…」里的).
- 在创作中试用 on a finished training ([training.md](/docs/reference/training.md#10-choosing-a-step-and-the-lora)) hands the Studio a `StudioTryRequest` through the store (`lib/studioTry.ts`, `takeStudioTryRequest`). `StudioPage.tsx` takes it once and calls `tryLoraOnBoard` (`studio/nodes.ts`): a 风格 named after the training that holds the trained LoRA at strength 1, and beside it a new 画面 wired to that 风格, with the training's first sample prompt as its description, the settings of the newest 画面 or result, and no LoRA of its own. The 画面 is selected and the board fits the view.
- A 放大 (`CanvasUpscale`) is sized from its 原图 times `UPSCALE_SCALES` (1.5 or 2) within `MAX_DIMENSION` 2048 on the 16 px grid. 细节 sets the start strength: 贴近原图 0.25, 适中 0.4, 更多细节 0.55 (`UPSCALE_DETAIL`). Without a description it takes its 原图's, 风格 included, or `UPSCALE_FALLBACK_PROMPT`. It never adds a 高清修复 pass and has no regions or 风格 socket. The engine has no separate upscaler; this is the redraw 高清修复 does.

## 11. The assistant and 解析 on the board

The 助手 acts on the selected card through tools; [studio-assistant.md](/docs/reference/studio-assistant.md) has the registry, modes and cards. What the board itself does for it: the tool API lives in `studio/StudioPage.tsx` (`StudioToolApi`) and reads live state at call time; regions added by a tool go through the same `addRegion` and `editLayer` as the UI (`studio/canvases.ts`), so a tool cannot make a region the compiler rejects; a plan waiting for 审批 is previewed on the selected 画面 as dashed boxes tagged 方案 (`plannedRegions`, `lib/shell.ts` `planPreview`, `studio/RegionLayer.tsx`) until it is applied or dropped; `studio_create_scenes` places its new 画面 with `sceneCanvas` in free board spots.

解析 sits in the top bar next to 助手 (both open the right side; opening one closes the other) and changes nothing until the person acts. It reads a picture with KohakuGBC: a dropped file, a 作品 pick, or a picture already on the board; the run is one job in the main process (`main/services/gbc.ts` `startGbcJob`) with cache by picture hash, version, detector, provider and language, and progress on `Events.gbcJob`. The panel shows the caption and the boxes over the picture; 复制提示词 copies the caption; 变成画面 makes a 新 画面 with the description and the regions (the same `withParsedRegions` the card menu uses); 作为参考图 imports the picture and links it into the selected 画面 as a vision reference; 重新读 ignores the cache. 规模 picks one of the shipped control presets (小 / 中 / 大) and 程序 picks the plain program or GBC-Nest (分格), both passed as config layers after the generated machine (`gbcConfigLayers`): a missing preset is skipped, a version without `configs/programs/gbc_nest.py` is refused with a message. The job runs the installed version (`gbcVersionId`) unless the caller names another. The card menu 拆成区域 keeps its older quick path: it creates the 画面 next to the card and fills it, using the same parser. 自动 / 中文 / English controls the text: 自动 is English for a 画面 and Chinese for a training caption; 中文 translates through the same provider and falls back to the English with a warning. Without an install the panel offers 安装; 设置 › 功能 keeps the versions and the detector. The model starts on 设置 › 语言模型 › 看图, and the panel's own 看图的模型 picks another for one run; with no model that sees pictures the picker is hidden and 解析 opens the connect dialog (解析要用语言模型, only OpenAI 兼容 and Anthropic) and reads with the new connection. The e2e is `apps/desktop/e2e/specs/gbc.e2e.ts`.

## 12. Regions

Boxes are drawn by dragging on the selected 画面's face; a field opens on the box for its words and its kind (`studio/RegionLayer.tsx`, `RegionEditor`). Kinds are `ProjectLayerKind`: object (物体), character (人物) and text (文字); a text region carries `caption` for the lettering and `text` for the exact words, and shows the words on its box. Boxes move by dragging, resize from any corner, and have a right-click menu (改描述, 删除). The panel lists them (`studio/InspectorPanel.tsx`); list order is region numbering. The prompt the engine receives is always compiled from the description plus the visible regions (`studio/prompt.ts`, `lib/layout.ts`); a text region with empty `text` is a `prompt` blocker. The coordinate contract is in [layout-schema.md](/docs/reference/layout-schema.md).

## 13. Tests

The pure modules (`canvases.ts`, `links.ts`, `ports.ts`, `wires.ts`, `connect.ts`, `runs.ts`, `nodes.ts`, `jobInputs.ts`, `readiness.ts`, `mask.ts`, `prompt.ts`, `sampling.ts`) have no React and are unit tested in `apps/desktop/test/renderer/studio/`, with `fixtures.ts` for sample projects. End to end: `apps/desktop/e2e/specs/board.e2e.ts`, `studio.e2e.ts`, `studio-inputs.e2e.ts` and `studio-cli.e2e.ts` against the mock backend (see `CONTRIBUTING.md`).
