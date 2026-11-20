---
status: current
last-verified: 2026-11-14 (1995a7a)
code: apps/desktop/src/shared/manga/, apps/desktop/src/main/services/manga.ts, apps/desktop/src/renderer/src/pages/manga/, apps/desktop/src/main/services/ai.ts
---

# 漫画

The 漫画 page turns a story into a serialized comic. A language model splits each chapter outline into pages and panels. Each panel is drawn by the engine from the series' 画风 and the 人物卡 of the characters in it, and waits for a person to review it. Approved pages are lettered and exported as PNG files. Paths are relative to `apps/desktop/src/`.

## 1. The document

One series is one `MangaSeries` (`shared/manga/model.ts`, zod schemas `mangaSeriesSchema` and `mangaSeriesSaveSchema`). Main stores it as `manga/<id>.json` under the data root and validates it on every read (`main/services/manga.ts`). A file that does not validate is skipped.

| Part | Field | Holds |
| --- | --- | --- |
| Series | `title`, `logline`, `readingDirection` (`rtl` \| `ltr`), `providerId` | Name, synopsis, page order, the language model used for storyboard and memory |
| 画风 | `style` | Description, negative description, LoRA, `monochrome` (成品为纯黑白), model (`modelBundleId`, absent = the one 创作 uses), steps and CFG |
| 人物卡 | `characters[]` | `appearance` (never changes), `personality` (language model only), `triggerWords`, `references` (up to 8), `referenceStrength` (参考强度, 0.1 to 1, absent = 1), `outfits` with `defaultOutfitId`, `adapters` |
| 章节 | `chapters[]` | `number`, `title`, `outline`, `summary` (剧情记忆), `pages` |
| Page | `pages[]` | `frames` (the split tree of section 2) and its `panels` in reading order: the n-th panel of the tree is `panels[n]` |
| 格 | `panels[]` | `scene`, `shot`, `angle` (角度, optional), `cast` (character, outfit, expression, pose), `dialogue` (balloons), `promptOverride`, `state`, `takes`, `chosen`, `note`, `attempts`, `error`, `retryAt` |
| 设定 | `facts[]` | Facts later chapters must keep; `chapterId` marks the chapter that set one |

Every series owns a Studio project named `漫画 · <title>`, with `seriesId` set (`projectId`). Reference pictures are imported into that project's assets through `studio:import-image`. As a result, `clover://` serves them and `/api/engine-jobs` accepts them as inputs without new allow-lists. Deleting the series deletes that project. Saving recreates the project if it was deleted from the Studio.

IPC channels (`shared/channels.ts`): `manga:list`, `manga:get`, `manga:save`, `manga:delete`, `manga:export`, and `ai:complete` for one request to a language model without a conversation or tools (`complete` in `main/services/ai.ts`). `manga:list` answers `seriesSummary` for each series. Its `cover` is the first approved picture in reading order, else the first character's first reference picture, and the 漫画 list shows it on the series' card.

## 2. Page and panel geometry

`shared/manga/layouts.ts` defines the page: B5 ratio, 1456 × 2056 px (8 px a millimetre), a 72 px margin, a 24 px gutter, and 120 px (15 mm) as a panel's narrowest side. A page's `frames` is a split tree. A leaf is one panel, and `bleed` lets it run past the paper on the sides that touch the margin. A split cuts its area across (`y`) or down (`x`) at `ratio` of the length less one gutter. `slant` puts the far end of the cut further along than the near end, so panels are convex quadrilaterals.

The tree is in reading order: a split's `first` is read first, so the leaves in tree order are the panels in order. Geometry is worked out with `first` on the left and mirrored for `rtl`. Turning the reading direction mirrors the page and keeps every panel's content. The schema checks that the tree has one leaf per panel. A page saved before `frames` existed names a template in `layoutId` and reads as that template.

- `panelQuads` gives each panel's quadrilateral, with `bleed: true` as printed.
- `frameHandles` and `dragGutter` move a gutter and keep its slant. Both sides keep room for their panels.
- `splitFrame`, `mergeFrame` (only two panels cut by the same split) and `setBleed` change one panel's frame.
- `PAGE_TEMPLATES` are eight ready-made trees. 套用版式 applies one, and the storyboard falls back to them (section 3).
- `panelGenerationSize` gives the size a panel is drawn at: the shape of its frame's bounding box as printed, about one megapixel, on the 16 px grid, each edge between 512 and 2048.

`shared/manga/gacha.ts` is 抽卡:

- `drawLayouts` grows layouts row by row in a style (`LAYOUT_STYLES`: 对话, 标准, 动作, 扉页). A style sets the number of rows and how often gutters slant, panels bleed, a column is cut again, and one panel is made big.
- With an exact panel count, the last third of the attempts cut one panel at a time instead.
- Layouts that do not fit are dropped and repeats are removed. The rest are scored: no long thin panels, sizes that vary, and rows read one after another.
- The same seed, page and settings give the same draw (`DrawStream`).
- `applyFrames` puts new frames on a page and keeps its panels in reading order. Blank panels (`isBlankPanel`) are added, or dropped from the end. It refuses frames that would drop a panel with content.
- `drawShots` gives every panel still in `draft` a random shot and angle. A page opens wide, wide panels lean to wide shots and small ones to close-ups, and the same shot twice in a row is drawn less.

The geometry, styles, scoring and shot rules follow the 漫画分镜工作台 of [Penna](https://github.com/storyAura/Penna) (`lib/core/harness/manga`, MIT License, Copyright (c) 2026 storyAura). The random numbers are this repo's own, so a seed does not give Penna's pages.

`pages/manga/PageLayout.tsx` is the page's 分格 beside its panels:

- the preview with the frames and balloons on top. Click a panel to pick it, and drag a gutter or a balloon, or focus it and use the arrow keys (section 5);
- 上下拆开 and 左右拆开 (disabled, with the reason, at 12 panels or when the panel is too small to cut), 合并 (refused when both panels have content) and 出血 for the picked panel;
- 抽分格: a style, a panel count (the current one by default), and eight candidates. The first one with room for the panels that have content is previewed until 用这张; one without room cannot be picked;
- 套用版式 and 抽镜头.

## 3. Storyboard and memory

`storyboardRequest` (`shared/manga/storyboard.ts`) gives the model the series, the character sheet, the story so far and the outline. It also lists the only layout styles (`LAYOUT_STYLES`: dialogue, standard, action, splash), template ids, shots and balloon kinds the model may use. The model must answer one JSON object. `parseStoryboard` maps the answer onto the series:

- names map to characters, and outfits are matched by name;
- a page with a `style` gets the best-scoring frames `drawLayouts` draws in that style for its panel count, seeded by the page id, so an action page can come with slanted and bleeding panels;
- a page without a known style takes its `layout` template; one whose panel count does not match is replaced, and a page with too many panels is split;
- `angle` is kept when it is one of `ANGLES` and not eye level;
- unknown characters are dropped, and balloons are placed from the reading side (`defaultBalloonPlaces`).

Text longer than the document allows is cut, and extra characters or lines are dropped. Each change is reported as a warning (分镜有几处自动调整了) instead of failing. An answer that still would not save is refused, so a storyboard never breaks later saves.

`storyMemory` (`shared/manga/memory.ts`) is the story so far: earlier chapters' summaries in order, then all facts, within `MEMORY_BUDGET` characters. The oldest summaries are dropped first. 写入剧情记忆 sends `memoryRequest` and stores the answer. The chapter gets a new `summary`. `mergeFacts` replaces the facts that chapter set before and keeps the ones the author wrote. The 剧情记忆 tab shows the result and what the next chapter will be given.

## 4. Drawing, retries and review

A panel's `state` is the queue (`shared/manga/queue.ts`):

| State | 显示 | Next |
| --- | --- | --- |
| `draft` | 未生成 | 生成 or 生成全部 → `queued` |
| `queued` | 排队中 | sent → `running`; 取消排队 / 停止排队 → `draft` or `review` |
| `running` | 生成中 | job succeeded → `review`; failed → `queued` again with `retryAt` set `RETRY_BACKOFF_MS` × attempts ahead (15 s, then 30 s), until `MAX_ATTEMPTS` (3), then `failed`; canceled → `draft` or `review` |
| `review` | 待审核 | 通过 / 全部通过 → `approved`; 重画 with a note → `queued` |
| `approved` | 已通过 | 重画 → `queued` (earlier takes are kept) |
| `failed` | 失败 | 再试一次 → `queued` |

`useDrawingQueue` (`pages/manga/useDrawingQueue.ts`) runs while the page is mounted. It sends nothing until the model library (`catalog`) has loaded, so a queue resumed at start-up is not failed as 还没有可用的模型. `reconcile` folds every job update into its panel. `nextToSubmit` sends at most `MAX_ACTIVE` (2) panels at a time across the whole series, in reading order chapter by chapter, and skips a retry whose `retryAt` has not come; `nextRetryAt` wakes the queue when it does. Because the queue is stored in the panels, a restart resumes it.

`panelRequest` (`pages/manga/submit.ts`) builds the same request the Studio posts to `/api/engine-jobs` (see [project-and-backend.md](/docs/reference/project-and-backend.md)). `projectId` is the series' project and `canvasId` is the panel id. The parts come from `compilePanelPrompt` (`shared/manga/prompt.ts`):

- the description is the 画风, the shot and angle, the scene, one line per character (trigger words, appearance, outfit, expression, pose) and the reviewer's note. It never mentions balloons, not even to leave room for them: such a line made the model draw gibberish balloons of its own ([consistency test](/docs/records/2026-11-13-manga-consistency.md));
- 文字，对白框，水印 is added to the negative description, so lettering is never drawn into the picture, and 彩色 when the series is `monochrome`;
- the LoRA list is the style's LoRA plus each character's, without repeats;
- the first reference picture of each character goes into the prompt as `visionReferences` (MossInfer's `vision_references`: the text encoder's vision tower turns it into prompt tokens). Its size (`maxPixels`, MossInfer's `max_pixels`) follows the shot (`REFERENCE_PIXELS`): 25000 for wide and full shots, 50000 for medium and close shots, 100000 for extreme close-ups. A picture carries its pose, weather, background and framing along with the face, and fewer tokens leave more of that to the description. The card asks for a front-facing head-and-shoulders portrait on a plain white background, not a crop from a panel. A character's 参考强度 below 1 is sent as `weight`, the lowest of the panel's referenced characters (the engine takes one per request), and only to an engine with `visionGuidance`: there the weight blends the predictions with and without the pictures, so the prompt's framing, pose and scene come through, at about half as much time again per panel ([MossInfer: vision references](https://github.com/mossimage-cpp/mossimage.cpp/blob/main/docs/c-api.md#vision-references)). An older engine fades the picture toward gray with `weight`, which barely changes a black and white portrait, so it gets none and the panel says it ran at full strength.

LoRA and pictures the engine does not support (`engine:features`; pictures need `visionReferences`, which MossInfer declares as `vision_references` in `hello`) are left out with a notice. The engine's other `references` belong to an edit adapter and do nothing without one, so 漫画 never sends them. A missing model or LoRA, or an empty scene, fails the panel without a retry. Every attempt draws a new seed.

## 5. Lettering and export

`pages/manga/render.ts` draws a page on a canvas. It fills white paper, covers each frame's bounding box with the panel's chosen picture and clips it to the frame (in grayscale when the series is `monochrome`, since a description alone does not keep the engine from using colour), strokes the frame, and draws the balloons on top, inside the largest upright rectangle of the frame within the margins (`innerRect`), so a bleeding panel's balloons stay on the paper. `layoutBalloon` and `wrapText` (`shared/manga/balloons.ts`) size balloons, with text at most 30% of the panel wide, and break their lines. Closing punctuation never starts a line and hangs past the edge instead, and an opening bracket never ends one (禁则). 对白 balloons are ellipses, 心声 dashed ellipses, 喊叫 spiked and 旁白 boxes. A balloon is placed by one of nine spots (`BALLOON_SPOTS` in `shared/manga/balloons.ts`). A balloon's `x` and `y` are anchors: 0 and 1 put it against an edge, with a margin, so a corner balloon stays in its corner. New balloons fill the corners in reading order (`defaultBalloonPlaces`). Nothing detects faces, and the description does not mention balloons (section 4), so a balloon over a face is moved by hand: by another spot on the panel card, or by dragging it on the page preview (or focusing it and using the arrow keys). A drag sets the anchors that put the balloon's centre nearest the pointer (`anchorAlong`, the reverse of `placeAlong`), so a dragged balloon keeps its margin. `placedBalloons` (`pages/manga/render.ts`) gives the editor the same boxes the page is drawn with. The page preview and the exported file are the same drawing.

导出这一话 is enabled once every panel of the chapter is approved (`exportBlockers`). It renders each page to PNG and sends the pages to `manga:export`. A chosen picture that can no longer be read stops the export with the page and panel named (`missingPictures`), instead of a blank frame. Main asks for a folder and writes `<folder>/<title>/第<N>话-01.png` and onwards (`writeChapterPages`). It refuses anything that is not a PNG.

## 6. Tests

| What | Where |
| --- | --- |
| Model, frames, 抽卡, prompts, storyboard, memory, queue, balloons | `test/shared/manga/` |
| Storage, backing project, export | `test/main/manga/manga.test.ts` |
| `complete` | `test/main/services/ai.test.ts` |
| Page logic and the job request | `test/renderer/manga/` |
| Fixtures and mock channels | `test/mocks/backend/manga.ts`, `test/mocks/backend/index.ts` |
| The whole flow, and both themes | `e2e/specs/manga.e2e.ts`, the `manga` stops in `e2e/specs/visual.e2e.ts` |
