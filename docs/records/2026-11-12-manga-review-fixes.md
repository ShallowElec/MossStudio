---
status: record
date: 2026-11-12
---

# 漫画 review fixes, 2026-11-12

The first run against a real engine and language model found four problems: a readiness race, retries that came too soon, colour in "black and white" pages, and balloons over faces. This record lists each one, what changed and how it is tested. It follows the [test report](2026-11-12-manga-test-report.md); the review itself was run on an RTX 4070 Laptop GPU (8 GB) with MOSS-Image SFT INT8, MossInfer 2.2.1 (CUDA 13), and an OpenAI-compatible Qianfan model. The fixes are in `afff0ea` on `feat/manga-studio`.

## What the review confirmed

A real storyboard (6 pages, 12 panels in about 15 s), chapter memory carried into the next chapter, two panels drawn at 1200 × 864, redraw with a reference picture and a note, PNG export at 1456 × 2056, and deleting a 漫画 with its project. Not covered: LoRA, an engine without LoRA or references, quitting while panels run, other language model providers, long-run character consistency.

## Findings and changes

| # | Finding | Cause | Change | Test |
| --- | --- | --- | --- | --- |
| 1 | Right after reopening, 生成全部 failed every panel with 还没有可用的模型, shown as 试了 0 次都没成功 | The queue ran before the model library had loaded; an empty catalog reads as no model, which is not retried | The queue sends nothing until `catalog` has loaded; `panelRequest` treats a missing catalog as retryable (正在读取模型库…); a request never sent reads only its reason (`panelErrorText`) | `test/renderer/manga/submit.test.ts`, `test/renderer/manga/logic.test.ts`; E2E 「after a restart, waits for the model library」 holds `models:catalog` |
| 2 | Both panels failed three times with E_OOM (0.10–0.24 GiB free) | A failed run was sent again at once, before memory could free | Each retry waits `RETRY_BACKOFF_MS` × attempts (15 s, then 30 s), stored as `retryAt`; the panel says 「N 秒后重试」 | `test/shared/manga/queue.test.ts`; E2E fast-forwards the page clock past the wait |
| 3 | A "黑白漫画" page had an orange cat and warm light | A description does not bind the engine to grayscale | New `style.monochrome` (设定 › 成品为纯黑白, on for new series): pictures are drawn in grayscale in the preview, the panel thumbnails and the export, and 彩色 is added to the negative description | `test/shared/manga/prompt.test.ts`; E2E 「turns pages strictly black and white」 |
| 4 | Long balloons covered faces | Balloons were centred on a point near the middle of a panel's top, and up to 40% of its width | Spot coordinates are anchors, so corner balloons sit in their corner with a margin; new balloons fill the corners in reading order; text is at most 30% of the panel wide; the description tells the engine where the balloons go (构图：右上留出空白放对白…) | `test/shared/manga/balloons.test.ts`, `prompt.test.ts` |

Finding 4 is reduced, not solved: nothing detects faces. For a picture already drawn with a face in a corner, the balloon still has to be moved to another spot by hand. Finding 2 was not reproduced under the new wait. Whether 15 s is enough depends on what else holds graphics memory.

## Checks after the changes

| Check | Result |
| --- | --- |
| `pnpm lint` | 0 errors, the same 12 warnings as `main` |
| `pnpm format:check`, `pnpm typecheck` | Pass |
| `pnpm test:unit` | 216 files, 3660 tests, all pass |
| `pnpm build && pnpm test:e2e` | 16 files, 374 tests, all pass |
| Linux x64 artifacts `2.1.0-manga.2` | `verify-artifacts.mjs` ok for full zip, setup and portable; portable `--smoke` exits 0 |

| File | SHA-256 |
| --- | --- |
| `MossStudio-Setup-2.1.0-manga.2-linux-x64.run` | `b885d15325dbb479f98d9c1ee62c06beb4ccea74f0643f8dab886c25e4422bc0` |
| `MossStudio-2.1.0-manga.2-linux-x64-portable.tar.gz` | `90fa19442833082b4649d8be9ad4ab310c098273fbef13cd2e5c55afbd059ebb` |
| `MossStudio-2.1.0-manga.2-linux-x64-full.zip` | `171bb1723b235d1a4fe87ffa5f71650caee5e3a824b40aaf404a68e75c0e52b1` |
| `files-2.1.0-manga.2-linux-x64.json` | `1833c4778dc0f74c267d62b9334699983c2c6474c92947af2a90e12bcaf8463f` |

## To check again on real hardware

1. Reopen the app with panels queued and press nothing: they start once the model library is read.
2. Force an out-of-memory run (another job on the GPU): the panel waits 15 s, then 30 s, between tries.
3. Turn on 成品为纯黑白 and export the page with the orange cat: no colour is left.
4. Storyboard and draw a new chapter: faces avoid the balloon corners more often than before (judgement).
