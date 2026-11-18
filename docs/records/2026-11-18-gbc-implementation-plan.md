---
status: record
date: 2026-11-18
---

# KohakuGBC 2.0 entries: implementation plan

The decisions below were made after the survey in [2026-11-18-gbc-survey-and-plan.md](/docs/records/2026-11-18-gbc-survey-and-plan.md). This record turns the two entries into work: a top-bar 解析 panel in the Studio, and a 训练 labelling batch. It is the plan the integration PR is written against; when it lands, the reference docs are updated and this record stops being the source of truth.

## 1. Decisions

| # | Question | Decision |
| --- | --- | --- |
| 1 | Where the Studio entry lives | Studio **top bar** (`Toolbar.tsx`), openable from anywhere on the board; the card menu 拆成区域 becomes a shortcut into the same panel with its picture filled |
| 2 | Output language | One control: **自动 / 中文 / English**. 自动 follows the destination: a 画面 description is English (the engine's prompt language), a training caption is Chinese. 中文 and English force it everywhere |
| 3 | Batch scope and cost | The panel has a **scope selector** (selected / without a description / all). More than **10** pictures asks for one confirmation with the estimate before it starts |
| 4 | What training data GBC may write | Only what the trainer reads today: **the `.txt` caption**. Boxes and tags are kept in the graph JSON for later; nothing else is written into `dataset/` |
| 5 | Installing GBC | A **guided install inside the 解析 panel** on first use (the existing 设置 › 功能 install runs behind it, with its progress); 设置 keeps the full configuration and version management |

## 2. Scope

P0 (Studio) and P1 (训练), in that order, on one branch, reviewed as one PR. Not in scope: tags, GBC-Nest, region-aware training data, `gbc host` remote engines, a graph editor.

## 3. Shared foundation

### 3.1 Result model

`shared/gbc.ts` gains a graph-carrying result, without changing what `parseRegions` returns today:

```ts
/** One picture's graph as the UI reads it: boxes normalised to the picture, edges kept for later. */
export interface GbcPicture {
  summary: string            // the image vertex's short caption
  detail?: string            // the image vertex's detailed caption
  regions: GbcRegion[]       // entity vertices with a box, as parseRegions returns today
  graph?: GbcGraph           // raw vertices and edges, for a later feature
}

export type GbcLanguage = 'auto' | 'zh' | 'en'
```

`GbcRunInput` gains `language?: GbcLanguage` (default `auto`). Main resolves `auto` to the destination it was called for (`studio` → `en`, `training` → `zh`), so the renderer never guesses.

### 3.2 Job model

`main/services/gbc.ts` already has the process, `graphs.jsonl`, cancel and progress. P0 adds one job layer above it:

- `startGbcJob(input, control)` → `{ jobId }`, emits `Events.gbcJob` `{ jobId, phase: 'starting' | 'running' | 'done' | 'failed' | 'canceled', done, total, current?: { key, name, phase } }`, resolves through a promise kept by job id.
- One job at a time per process; a second start is refused with a message the panel shows.
- Cancel ends the Python process tree (`stopGbcProcesses`), leaves finished pictures' graphs on disk, and reports `canceled`.
- Every job writes under `gbc-runs/<jobId>/` in user data: `graphs.jsonl`, `graphs.failures.jsonl`, `graphs.stats.json`, and the generated config. The run folder is what a resume would point at later.

### 3.3 Cache

Key: `sha256(file)` + `gbcVersionId` + detector + control preset + provider id + language. Value: the parsed `GbcPicture`. Stored in `gbc-cache/<key>.json`. A cache hit skips the process entirely. The panel shows 已缓存 for a hit; a batch counts hits as free.

### 3.4 Settings

One new key, no new flag: `gbcLanguage: GbcLanguage = 'auto'`, in `DEFAULT_SETTINGS` and `settingsUpdate` (enum). The 语言 control in both panels writes it and reads it back, so switching in one place changes the default in the other.

## 4. P0 — Studio 解析 panel

### 4.1 Entry

`Toolbar.tsx`: a `解析` button with the GBC icon, left of the mask tool. Visible only when `gbcEnabled` (as the card menu is today). Clicking opens the panel; the card menu item calls the same panel with `source = { kind: 'board', canvasId }`.

### 4.2 Panel

New `pages/studio/GbcPanel.tsx` (right side, same width pattern as the assistant), plus `useGbcJob.ts` for the run state. Sections:

1. **Source**: a drop zone, `从作品选择` (existing gallery picker), `从画板选择` (the board's canvas list). One source pick is enough to enable 解析.
2. **Options** (collapsed to one line): 看图的模型 (providers from `useGbcState`), 找物体的方式 (OWLv2 / SAM 3), 规模 (small / mid / large), 语言 (自动 / 中文 / English).
3. **Result**: the picture thumbnail with boxes overlaid (hovering a row highlights its box), the caption as an editable textarea, the entity list with kind and box. A 已缓存 badge on a cache hit; failures show GBC's message and keep the run folder link.
4. **Actions**: 变成画面 (fills the description and regions of a new 画面, the code path `usePictureRegions` uses today), 只取提示词 (copies the caption; no canvas), 作为参考图 (links the picture as a vision reference to the selected 画面), 再解析 (same source, new preset).
5. **Install** (first use): when `gbcStatus` says unavailable, the panel shows the doctor's checks and an 安装 button that runs `Ipc.gbcSetup` with the existing progress events; 设置 › 功能 is linked for version management.

### 4.3 Refactor of the existing path

`usePictureRegions` keeps its job but its `parse` becomes a call into the same job layer, and `pictureRegions.ts` `withParsedRegions` is reused by 变成画面 so both entries produce identical 画面s. The card menu gains nothing new in P0 beyond opening the panel.

### 4.4 P0 tests

- Unit: `shared/gbc.ts` language resolution (`auto` → destination), region mapping from a graph (existing cases stay), cache key stability.
- Unit: a job-layer test with a stub `gbc` binary (`CLOVER_GBC_BIN` already exists) writing a fixture `graphs.jsonl`: success, failure, cancel, cache hit.
- E2E (`gbc.e2e.ts` grows): with the mock backend, the top-bar button opens the panel, a board source parses, 变成画面 creates a 画面 with N boxes and the caption, 只取提示词 puts the caption on the clipboard, the install state shows the doctor's message when unavailable, and the feature-off case hides the button.

## 5. P1 — 训练 labelling

### 5.1 Entry

`pages/training/Pictures.tsx` toolbar: `GBC 打标`, with the scope selector (选中 / 没有描述的 / 全部). Above 10 pictures, a confirmation shows the count and the estimated VLM calls.

### 5.2 Flow

1. Start a job over the chosen names (`startGbcJob` with `files`), progress in the dataset toolbar, 停止 cancels.
2. Each result is written to `training/<id>/gbc/<stem>.json` (the `GbcPicture`) and enters a review queue.
3. The review panel (right side, or a dialog if 训练's layout prefers it) shows the picture, the **suggested caption** in an editable box, and the entity captions as optional extra lines (checkbox each, default off). A picture with a hand-written `.txt` shows 替换 as an explicit button, never silently overwritten.
4. 接受 writes through `Ipc.trainingCaptionSet`; 跳过 leaves it; 全部接受 applies the visible queue.
5. A summary at the end states how many were written, skipped, and failed.

### 5.3 Suggested caption

`renderTrainingCaption(picture, language)` (pure, in `shared/gbc.ts` so both processes agree): the image vertex's short caption, trimmed to one sentence, cleaned of leading "This image shows" style openers, never longer than the trainer's usual caption length. For 画风 the full sentence stays; for 人物 / 物品 the trigger word handling stays in `runCaption` as today, so the suggestion is what the user would have typed.

### 5.4 P1 tests

- Unit: caption rendering (Chinese and English, sentence trimming, empty caption), scope selection, queue state transitions.
- Unit: writing a `.txt` through the existing caption path, and the 替换 rule.
- E2E: mock a dataset of three pictures, run a mock batch, accept one, skip one, replace one, assert the `.txt` files and the stored graph JSON.

## 6. Work order and PR

1. This record and the survey, as a docs-only PR (branch `docs/gbc-2.0`).
2. P0 + P1 on `feat/gbc-entries`, one PR when both are green: foundation (§3) first, then the Studio panel, then the training batch. Commits stay reviewable per area even though the PR is one.
3. After the PR lands: update `reference/studio-node-board.md` (the panel), `reference/training.md` (the labelling flow), and a `last-verified` bump on both; the archived `gbc-integration.md` stays untouched.

## 7. Risks and fallbacks

- **Upstream churn**: pin a commit per release through `gbcGit`; validate `graphs.jsonl` with the loose types and keep the raw file per job.
- **Windows detector unproven**: P0's acceptance uses the API VLM + OWLv2 path; if `[torch]` turns out not to run on Windows, the plan falls back to "API only" and the detector control is hidden with the doctor's reason.
- **Cost**: the estimate uses 10 VLM calls per picture as a floor (the README shows 3 to 30+); the confirmation says it is a floor.
- **Cancel semantics**: a killed job leaves `<training>/gbc/<stem>.json` for the pictures that finished; the review queue only offers files that exist, so a cancel never shows a half result.

## 8. Acceptance

- A dropped picture becomes a 画面 with boxes, and the same caption with 只取提示词, on Windows with a real provider.
- A 20-picture dataset is labelled and reviewed in under 10 minutes on the test machine, with no hand-written caption overwritten.
- Every new behaviour above has the unit or E2E test named in §4.4 and §5.4; the full `pnpm test:unit` failure set does not grow beyond the known Windows-environment failures.
