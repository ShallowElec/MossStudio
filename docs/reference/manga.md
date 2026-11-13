---
status: current
last-verified: 2026-11-12 (afff0ea)
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
| 人物卡 | `characters[]` | `appearance` (never changes), `personality` (language model only), `triggerWords`, `references` (up to 8), `outfits` with `defaultOutfitId`, `adapters` |
| 章节 | `chapters[]` | `number`, `title`, `outline`, `summary` (剧情记忆), `pages` |
| Page | `pages[]` | `layoutId` (a template from `shared/manga/layouts.ts`) and its `panels` in reading order |
| 格 | `panels[]` | `scene`, `shot`, `cast` (character, outfit, expression, pose), `dialogue` (balloons), `promptOverride`, `state`, `takes`, `chosen`, `note`, `attempts`, `error`, `retryAt` |
| 设定 | `facts[]` | Facts later chapters must keep; `chapterId` marks the chapter that set one |

Every series owns a Studio project named `漫画 · <title>`, with `seriesId` set (`projectId`). Reference pictures are imported into that project's assets through `studio:import-image`. As a result, `clover://` serves them and `/api/engine-jobs` accepts them as inputs without new allow-lists. Deleting the series deletes that project. Saving recreates the project if it was deleted from the Studio.

IPC channels (`shared/channels.ts`): `manga:list`, `manga:get`, `manga:save`, `manga:delete`, `manga:export`, and `ai:complete` for one request to a language model without a conversation or tools (`complete` in `main/services/ai.ts`).

## 2. Page and panel geometry

`shared/manga/layouts.ts` defines the page (B5 ratio, 1456 × 2056 px, margin and gutter) and eight templates (`PAGE_LAYOUTS`). Each template is a list of rectangles in right-to-left reading order. `orientedRects` mirrors them for `ltr`. `panelGenerationSize` gives the size a panel is drawn at: its shape on the page, about one megapixel, on the 16 px grid, each edge between 512 and 2048.

## 3. Storyboard and memory

`storyboardRequest` (`shared/manga/storyboard.ts`) gives the model the series, the character sheet, the story so far and the outline. It also lists the only layout ids, shots and balloon kinds the model may use. The model must answer one JSON object. `parseStoryboard` maps the answer onto the series:

- names map to characters, and outfits are matched by name;
- a layout whose panel count does not match is replaced, and a page with too many panels is split;
- unknown characters are dropped, and balloons are placed from the reading side (`defaultBalloonPlaces`).

Each change is reported as a warning (分镜有几处自动调整了) instead of failing.

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

`useDrawingQueue` (`pages/manga/useDrawingQueue.ts`) runs while the page is mounted. It sends nothing until the model library (`catalog`) has loaded, so a queue resumed at start-up is not failed as 还没有可用的模型. `reconcile` folds every job update into its panel. `nextToSubmit` sends at most `MAX_ACTIVE` (2) panels at a time, in reading order, and skips a retry whose `retryAt` has not come; `nextRetryAt` wakes the queue when it does. Because the queue is stored in the panels, a restart resumes it.

`panelRequest` (`pages/manga/submit.ts`) builds the same request the Studio posts to `/api/engine-jobs` (see [project-and-backend.md](/docs/reference/project-and-backend.md)). `projectId` is the series' project and `canvasId` is the panel id. The parts come from `compilePanelPrompt` (`shared/manga/prompt.ts`):

- the description is the 画风, the shot, the scene, one line per character (trigger words, appearance, outfit, expression, pose), where the balloons go (`balloonRoomHint`: 构图：右上留出空白放对白…) and the reviewer's note;
- 文字，对白框，水印 is added to the negative description, so lettering is never drawn into the picture, and 彩色 when the series is `monochrome`;
- the LoRA list is the style's LoRA plus each character's, without repeats;
- the first reference picture of each character is attached.

LoRA and references the engine does not support (`engine:features`) are left out with a notice. A missing model or LoRA, or an empty scene, fails the panel without a retry. Every attempt draws a new seed.

## 5. Lettering and export

`pages/manga/render.ts` draws a page on a canvas. It fills white paper, crops each panel's chosen picture to its frame (in grayscale when the series is `monochrome`, since a description alone does not keep the engine from using colour), strokes the frame, and draws the balloons on top. `layoutBalloon` and `wrapText` (`shared/manga/balloons.ts`) size balloons, with text at most 30% of the panel wide, and break their lines. 对白 balloons are ellipses, 心声 dashed ellipses, 喊叫 spiked and 旁白 boxes. A balloon is placed by one of nine spots (`BALLOON_SPOTS` in `shared/manga/balloons.ts`). A balloon's `x` and `y` are anchors: 0 and 1 put it against an edge, with a margin, so a corner balloon stays in its corner. New balloons fill the corners in reading order (`defaultBalloonPlaces`). Nothing detects faces: the description asks the engine to keep them out of the balloons' spots, and a picture already drawn may still need another spot chosen by hand. The page preview and the exported file are the same drawing.

导出这一话 is enabled once every panel of the chapter is approved (`exportBlockers`). It renders each page to PNG and sends the pages to `manga:export`. Main asks for a folder and writes `<folder>/<title>/第<N>话-01.png` and onwards (`writeChapterPages`). It refuses anything that is not a PNG.

## 6. Tests

| What | Where |
| --- | --- |
| Model, layouts, prompts, storyboard, memory, queue, balloons | `test/shared/manga/` |
| Storage, backing project, export | `test/main/manga/manga.test.ts` |
| `complete` | `test/main/services/ai.test.ts` |
| Page logic and the job request | `test/renderer/manga/` |
| Fixtures and mock channels | `test/mocks/backend/manga.ts`, `test/mocks/backend/index.ts` |
| The whole flow, and both themes | `e2e/specs/manga.e2e.ts`, the `manga` stops in `e2e/specs/visual.e2e.ts` |
