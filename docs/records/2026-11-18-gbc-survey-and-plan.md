---
status: record
date: 2026-11-18
---

# KohakuGBC in 2.0: survey, and a plan for two entries

KohakuGBC turns one picture into a graph: an image caption, entity boxes with their own captions, and the containment and relation edges between them. This repository already parses a single card picture with it, behind 设置 › 功能 and a card menu. The 2.0 Studio and the training dataset want two more entries: a top-bar 解析 that turns any picture into a prompt and a bbox layout, and a training-side batch that proposes captions and tags for a dataset. The survey below is what upstream offers today, what our code already does, and a phased plan; nothing was implemented for this record.

## 1. What was read, and how

- Upstream: the repository metadata and `README.md` of [KohakuBlueleaf/KohakuGBC](https://github.com/KohakuBlueleaf/KohakuGBC) on 2026-11-18 (`main`, last push 2026-11-07). The published PyPI entries `kohakugbc` and `kohakugbc-data` are named in that README; the local machine was not asked to install or run either.
- This repository at `e8c8628`: `apps/desktop/src/shared/gbc.ts`, `main/services/gbc.ts`, `main/services/gbcGit.ts`, `renderer/src/lib/gbc.ts`, `renderer/src/pages/studio/usePictureRegions.ts`, `pages/studio/pictureRegions.ts`, `pages/settings/GbcSettings.tsx`, `pages/studio/Board.tsx`, and the training dataset and caption code named in [training.md](/docs/reference/training.md).
- No timing, VRAM or quality number below was measured on our hardware. The numbers quoted as "upstream" come from the README; the plan's phase gates say which ones we still have to measure.

## 2. What upstream is, in 2026-11

KohakuGBC is a young project: created 2026-10-22, 81 stars, 4 forks, Apache-2.0, Python. The data package has two tagged releases, `data-v0.1.0` (2026-10-27) and `data-v0.2.0` (2026-11-06), with abi3 wheels for Linux (x86_64 and aarch64), Windows x64 and macOS; the program package itself has no tagged release, so a pin is a commit. It packages Graph-Based Captioning (the [ml-gbc](https://github.com/apple/ml-gbc) idea) as one KIR program on the author's Togeari dataflow machine, and ships the engines that run it.

| Piece | What it gives us |
| --- | --- |
| `kohakugbc-data` | The graph store, graph resolution and prompt rendering, and the dataset format; depends on numpy, pillow, pyarrow and KohakuVault only |
| `kohakugbc` | The program (`gbc.kir`), the machine, the CLI (`gbc`), and the engines |
| Extras | `[torch]` OWLv2 or SAM 3 detector and EmbeddingGemma; `[vllm]` and `[qwen35]` local VLM engines; the README marks `[vllm]` Linux only and `[qwen35]` Windows and Linux, and says nothing about `[torch]`'s platforms |
| Releases | `kohakugbc-data`: `data-v0.1.0` (2026-10-27) and `data-v0.2.0` (2026-11-06), abi3 wheels for Linux x86_64 / aarch64, Windows x64 and macOS; `kohakugbc` is pinned by commit |
| CLI | `gbc run <config>`, `gbc check <config>`, `gbc host <config> --slot … --listen …`, `gbc doctor` |
| Config | Python files merged key by key; `engines`, `machine`, `source`, `sink`, `controls`; presets in `configs/controls/` (`small`, `mid`, `large`, `sam3`) |
| Output | `graphs.jsonl` (one graph per image, the ml-gbc JSON), `graphs.failures.jsonl`, `graphs.stats.json`; a `vault` sink writes the same three into one KohakuVault file |
| Graph | Image root with a short and a detailed caption; entity vertices with `bbox` and `label` (`image` / `entity` / `composition` / `relation`) and `descs`; every edge is a phrase of its parent caption and its child box sits inside the parent's |
| Tags | With `root: tags` or `regions` tagging, `tag_select` / `tag_min_tags` / `tag_max_regions` produce tags from the graph (GBC-Nest's "important vertices" preset exists) |
| GBC-Nest | A second program: grounded root over text, panels and people, hierarchy from containment; better for comics and multi-panel pages |
| Dataset | `kohakugbc_data.dataset`: KohakuClip image shards plus graphs and per-image metadata in KohakuVault, joined by key |
| Engines | `api` (any OpenAI-compatible or Anthropic endpoint, one unit per endpoint), `vllm`, `qwen35`, `torch` (detector and embedder), `python` (CPU lanes), `remote` (`gbc host`), `replay` (recorded traces, no models) |
| Local footprint | A one-GPU config with Qwen3.5-4B, OWLv2 and EmbeddingGemma is stated as 24 GiB |
| Speed | Stated 2.06 images/s on one RTX 5090 in the default one-engine-host-per-card setup; 34 s for one portrait on an RTX 4090 with OWLv2, 79 s with SAM 3 |
| Controls that matter to us | `min_nodes` / `max_nodes` / `max_rounds`, `root` (`query` / `text` / `image_text` / `tags`), `max_side`, `box_score`, `nms_iou`, `tag_*` |

Three properties make it a good fit rather than a dependency to vendor: the graph is the interface (we read `graphs.jsonl`), the model calls can go over any OpenAI-compatible API (so the assistant's provider works), and a recorded run replays without models (useful for tests).

Two properties make it a risk: the project is weeks old, and its CLI, config shape and control names can still change; and the local stack is large — torch, a detector, an embedder, and a VLM either as ~24 GiB of weights or as paid API calls per image.

## 3. What this repository already has

The integration is older than the 2.0 Studio and is unevenly finished.

| Piece | State |
| --- | --- |
| Feature flag | `gbcEnabled`, default **off**; 设置 › 功能 shows GbcSettings only when on |
| Settings | 安装 (code through a git mirror, then the Python packages), a 运行环境 line with the doctor's answer, a detector choice (OWLv2 / SAM 3), the 看图的模型 provider, and version management: any branch or commit becomes a version, several can be installed side by side |
| Versions | `gbcGit.ts`: a bare mirror, branches, commits, create and remove; the settings hold `gbcVersionId` |
| Parse one picture | `parseRegions(runId, path)`: runs GBC on one file, reads the first graph, returns `{ summary, regions }` with normalised boxes, at most 12 regions and no box covering 0.9 of the picture (`GBC_MAX_REGIONS`, `WHOLE_PICTURE` in `shared/gbc.ts`) |
| Studio entry | Board card menu 拆成区域 (`Board.tsx`) → `usePictureRegions`: makes an empty 画面 beside the picture, fills it with the parsed regions and the summary as its description, may take the 画面 away again on 停止 or failure |
| Batch run | `runGbc(input)` with `folder` or `files`, a provider, a detector, sidecars (`sidecarJson`, `sidecarTxt`), and a control object; `gbcListImages`, `gbcThumbnails`; the IPC channels and zod schemas exist |
| Dormant | No renderer calls `gbcRun`, `gbcListImages` or `gbcThumbnails`; nothing in 训练 uses GBC; `edges` and `composition` / `relation` vertices are kept in `GbcRunResult` but no UI shows them; tags are never requested |
| Training today | Pictures copied into `training/<id>/images/` with a same-stem `.txt`; 自动写描述 asks the assistant's provider for one short Chinese sentence per picture; a run reads `training/<id>/dataset/` rebuilt per start ([training.md](/docs/reference/training.md) section 6) |

So the expensive half — installing, versioning, running GBC, reading graphs, and turning a graph into a 画面 — exists. What is missing is the two entries the product wants, and a result model richer than `{ summary, regions }`.

## 4. Two jobs to be done

1. **Studio: any picture → prompt and layout.** The user drops a picture (from disk, 作品, or a card on the board) and gets: one description they can hand to 生成, and the boxes for the main subjects, as a 画面. Today this exists only for a picture already on a card, only from a card menu, and never as "just the prompt".
2. **训练: a dataset labelled.** The user has 20 to a few hundred pictures and does not want to type a caption per picture. Today each picture gets one Chinese sentence from a VLM, with no boxes, no tags, and no structure; a GBC graph is exactly the structure that could fill that gap — if the review is cheap enough to be worth it.

The two share one pipeline: run GBC over one or many pictures, keep the graph, render it into something the destination understands (a 画面 with regions, or a `.txt` caption plus optional tags and boxes).

## 5. Design

### 5.1 One GBC layer in main, one result model

- Keep `gbc.ts` as the only owner of processes and of `graphs.jsonl`; no renderer changes to the CLI contract.
- Add a `GbcJob` abstraction on top of `runGbc`: source (one file, a folder, or a list), provider, detector, control preset, sink folder, and a job id; progress and cancellation per job (the parse path already has `cancelParse`, `stopGbcProcesses`).
- Extend the result from `{ summary, regions }` to `{ summary, regions, graph }` where `graph` keeps vertices (with `bbox`, `label`, `descs`) and `edges`; the existing `GbcVertex` / `GbcGraph` are already loose enough to hold it. Normalise `bbox` to 0–1 once, at the boundary.
- Cache by content hash + GBC version + control preset + provider id, in the user data folder; a second parse of the same picture is free. This matters most for training batches that are resumed.
- Every run writes its raw output under a run folder we control, so a later feature can replay a graph without re-running models.

### 5.2 Studio: a top-bar 解析 panel

Placement: a `解析` button in the Studio top bar (`Toolbar.tsx`), left of the mask tool, opening a right-side panel (same pattern as the assistant), not a modal — the user wants to see the board while deciding.

Panel:

- **Source**: drop an image, pick one from 作品, or pick a card on the board. The board pick reuses the card menu's path; the drop path is new.
- **Options**, collapsed to one line by default: 看图的模型 (provider), 找物体的方式 (OWLv2 / SAM 3), 规模 (small / mid / large control preset), 语言 of the rendered text.
- **Result**: the image caption (editable textarea) and the entity list with kind, caption and box; hovering an entity highlights its box on the preview. This is where the graph earns its keep over today's flat region list.
- **Actions**:
  1. 变成画面 — one new 画面 with the description and the regions, as `usePictureRegions` does today; the existing card-menu item becomes a shortcut into this panel with the source filled.
  2. 只取提示词 — copy the caption, no canvas. This is the "quick prompt from any image" case and needs no canvas at all.
  3. 作为参考图 — link the picture as a vision reference to the selected 画面 (the engine gained vision references in #89); the parse result can stay open beside it.
  4. 再解析 — same picture, different detector or preset.

Blocked states: feature off → the button is hidden (as the menu item is today); GBC not installed → the panel shows the doctor's answer and a button into 设置 › 功能; no provider → the panel says which provider field to fill.

Cost: one picture is one run; the README's own numbers put a portrait at tens of seconds. The panel shows a spinner with the phase (下载 detector / 读图) exactly as the card does now.

### 5.3 训练: a labelling batch with review

Entry: a `GBC 打标` button in the dataset toolbar (`Pictures.tsx`), with a scope choice: selected pictures, or every picture without a description.

Flow:

1. The panel estimates the work (pictures × VLM calls per picture, provider cost) and asks once before a batch over more than, say, 10 pictures.
2. The batch runs one job, cancellable, resumable: each finished picture writes its graph to `training/<id>/gbc/<stem>.json` and appears in a review queue.
3. The review shows one picture at a time: the image, GBC's short image caption as a **suggested** `.txt` (editable), and the entity captions as optional extra lines (a checkbox per entity, default off for 人物 / 物品, on for 画风 where longer text helps).
4. Accept writes through the existing `training:caption-set`; skip leaves the picture as it was; a picture that already had a hand-written `.txt` is never overwritten without an explicit "替换".
5. Phase 2: tags (`root: tags`, `tag_*` controls) stored beside the caption (`tags.txt` or the graph JSON) and shown in the review; region boxes in the graph stay available for a future region-aware trainer.

What this is not: not an automatic rewrite of the dataset. A caption is authored text the user signs off; GBC proposes, the user accepts. The batch's value is that reviewing 50 suggestions is minutes, while writing 50 captions is an afternoon.

## 6. Constraints and risks

- **Windows**: the data package ships Windows x64 wheels and `[qwen35]` is stated for Windows and Linux; `[vllm]` is Linux only, and the README does not state `[torch]`'s platforms — verify before promising a Windows detector. An 8 GiB card (our 2080) cannot hold the README's 24 GiB local config; the realistic Windows setup is API VLM + OWLv2 on the GPU, and we have not measured that combination yet.
- **First run**: detector and embedder downloads; GBC reports it as progress today (`GbcParseProgress` `download` / `reading`).
- **Upstream churn**: no tagged release; pins are commits through `gbcGit`. Validate `graphs.jsonl` against our loose types at the boundary and keep the raw file.
- **Cost**: an API VLM is billed per call and GBC makes many calls per picture (the README shows 3 to more than 30 VLM requests per image). The batch must estimate before it starts.
- **Quality on our material**: the README's examples are anime portraits and comics; manga panels are explicitly what GBC-Nest is for. We have no measured quality on the Studio's output style yet.
- **Disk**: one graph per picture is small; the `vault` sink and KohakuClip shards are not needed for our two entries and should not be turned on by default.

## 7. Phases

| Phase | Scope | Done when |
| --- | --- | --- |
| P0 | Studio top-bar 解析 panel: source (drop / 作品 / board), one run, preview, 变成画面 and 复制提示词; card menu opens the same panel | On Windows with a real provider: one dropped picture becomes a 画面 with N boxes, and the caption copied to the clipboard matches the panel |
| P1 | 训练 `GBC 打标`: batch + review queue, `.txt` writing through `training:caption-set`, graph JSON stored per picture, cancel and resume | 20 pictures labelled and reviewed in under 10 minutes on the test machine; no hand-written caption overwritten |
| P2 | Tags and GBC-Nest; 作为参考图; presets exposed; `gbc host` remote engines; region-aware training data | Decide after P1: tags usefulness in 画风 training, and whether GBC-Nest reads manga pages well enough to replace the plain program |

Not in scope for P0/P1: vendoring GBC, bundling its models in the installer, a graph editor, or writing boxes into the trainer's dataset format.

## 8. Open questions for the next review

1. Studio entry: top bar (as proposed) or the assistant panel? The top bar is one click from anywhere; the assistant is where 拆成区域 already lives for a card.
2. Language: the Studio's prompts are English; 训练's captions are Chinese. Should the panel offer both, or follow the destination (English for 变成画面, Chinese for 训练)?
3. Batch default: only pictures without a description, or everything selected? And is 10 the right threshold for the cost confirmation?
4. Does the trainer ever want boxes or tags, or is the caption the only thing it can use today? If the latter, P1 should write captions only and keep the graph for later.
5. Who installs GBC — the user through 设置 › 功能 (today), or a guided install inside the 解析 panel on first use?

## 9. References

- Upstream: [KohakuBlueleaf/KohakuGBC](https://github.com/KohakuBlueleaf/KohakuGBC), [Togeari](https://github.com/KohakuBlueleaf/Togeari), [ml-gbc](https://github.com/apple/ml-gbc), [KohakuVault](https://github.com/KohakuBlueleaf/KohakuVault).
- Ours: `shared/gbc.ts`, `main/services/gbc.ts`, `main/services/gbcGit.ts`, `pages/studio/usePictureRegions.ts`, `pages/studio/pictureRegions.ts`, `pages/settings/GbcSettings.tsx`, `pages/training/Pictures.tsx`, [training.md](/docs/reference/training.md), [studio-node-board.md](/docs/reference/studio-node-board.md), and the archived [gbc-integration.md](/docs/archive/gbc-integration.md).
