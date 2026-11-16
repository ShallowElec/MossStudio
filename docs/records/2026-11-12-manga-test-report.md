---
status: record
date: 2026-11-12
---

# 漫画 test report, 2026-11-12

Test results for the 漫画 workflow on branch `feat/manga-studio` at `7804338`. The workflow is described in [reference/manga.md](../reference/manga.md). Every automated check passes, and the Linux x64 build is packaged, verified and smoke-tested. Nothing has been run yet against a real engine or a real language model; section 5 is the checklist for that.

## 1. Environment

| | |
| --- | --- |
| OS | Arch Linux, kernel 7.2.14, x64 |
| GPU | NVIDIA GeForce RTX 4070 Max-Q (detected by the smoke run; not used by any test) |
| Toolchain | Node 26.13.1, pnpm 9.14.2, Go 1.27.4 |
| Headless display | `xvfb-run` (E2E runs without a visible window) |

## 2. Automated checks

| Command | Result |
| --- | --- |
| `pnpm lint` | 0 errors; 12 warnings, the same 12 as on `main` (none in new code) |
| `pnpm format:check` | Pass |
| `pnpm typecheck` | Pass (all five projects) |
| `pnpm test:unit` | 216 files, 3654 tests, all pass |
| `pnpm build && pnpm test:e2e` | 16 files, 372 tests, all pass |

## 3. Tests added for 漫画

### Unit tests (72)

| File | Tests | Covers |
| --- | --- | --- |
| `test/shared/manga/prompt.test.ts` | 5 | Panel description order (画风, shot, scene, characters); outfit chosen per panel; LoRA de-duplication; one reference per character; lettering kept out of the picture; reviewer note; empty scene and deleted character reported; `promptOverride` |
| `test/shared/manga/layouts.test.ts` | 5 | Every template covers the page without overlap; right-to-left order and left-to-right mirroring; template by panel count; margins and gutters; generation sizes on the 16 px grid, 512–2048, matching the panel's shape |
| `test/shared/manga/storyboard.test.ts` | 4 | The request carries characters, outfits, memory and outline; names and outfits mapped; balloons placed from the reading side; repairs reported as warnings (wrong layout, unknown character, unknown outfit, empty scene, too many panels); unreadable answers fail with a plain message |
| `test/shared/manga/memory.test.ts` | 5 | Story so far in chapter order, then facts; oldest summaries dropped first over budget; memory request carries the script; fenced and bare JSON parsed; a chapter's facts replaced and the author's kept |
| `test/shared/manga/queue.test.ts` | 10 | Queueing skips empty panels; at most two sent, in reading order; 停止排队; success → review; failure retried up to 3 times, with the error still shown during the retry; canceled runs and impossible requests not retried; other jobs ignored; 通过 and 重画 with a note; progress counts; catching up after a restart and failing a lost job |
| `test/shared/manga/balloons.test.ts` | 5 | Chinese and Latin line breaking; over-long words split; default balloon spots; balloon kept inside its panel; shout outline |
| `test/main/manga/manga.test.ts` | 8 | Series stored with its own Studio project; project renamed with the title and recreated after deletion; deleting removes the project; invalid files and ids refused; export file names; pages written into a folder named after the series; non-PNG refused |
| `test/main/services/ai.test.ts` (`complete`) | 2 | One request without tools or conversation; first provider used by default; no provider and empty answer reported |
| `test/shared/schemas.test.ts` (new schemas) | 20 | `aiComplete`, `mangaId`, `mangaSave`, `mangaExport`: valid input, limits and rejected shapes |
| `test/renderer/manga/submit.test.ts` | 3 | The engine request of a panel (project, description, LoRA, references, size from its shape); LoRA and references dropped with a notice when the engine lacks them; missing model or LoRA and empty scene refused without retry |
| `test/renderer/manga/logic.test.ts` | 5 | A new series passes validation; changing a template never drops panels with content; 全部通过 and export readiness; nearest balloon spot; fallbacks for fields emptied while typing |

### E2E tests (`apps/desktop/e2e/specs/manga.e2e.ts`, 3)

1. **Create and storyboard.** Create a 漫画 (its backing project appears), add a character, write an outline, 生成分镜. Checks that the request sent to the language model holds the character sheet and outline, that two panels with their scene and lines are shown, and that the save maps the character by id. Then 写入剧情记忆 adds the summary and fact shown under 剧情记忆.
2. **Draw, retry, review, export.** 生成全部 sends two jobs with the right project, LoRA, references and description. A finished job puts its panel up for review, and a freed slot sends the next panel. A failed job (显存不够) is retried and shows 上次没成功，正在重试. 重画 with a note sends a run whose description carries 修改要求. Then 通过 and 全部通过, and 导出这一话 sends one PNG page and confirms the folder.
3. **Character card.** Add a reference picture, which is imported into the series' project. Add an outfit, which becomes the default. The save holds both.

### Visual audit (`apps/desktop/e2e/specs/visual.e2e.ts`)

Six 漫画 states (empty, chapter, panels, characters, memory, settings), each in light and dark and at 1280×760 and 1600×1000. Checks no borders, theme colours only, readable contrast, no horizontal overflow, and no unhandled IPC channel. 24 tests, all pass.

## 4. Build artifacts

Built with `pnpm build`, `pnpm release:package --platform linux-x64 --version 2.1.0-manga.1`, `bash apps/launcher/build.sh` and `pnpm release:artifacts --platform linux-x64 --version 2.1.0-manga.1`, into `dist/release/artifacts/` (gitignored). The version is a pre-release so it cannot be mistaken for the shipped 2.0.0. The build carries no update key, so it never updates itself.

| File | Size | SHA-256 |
| --- | --- | --- |
| `MossStudio-Setup-2.1.0-manga.1-linux-x64.run` | 209 MB | `62ef0a528cf03f28d57da421c3c89ad3cdcba0f0d2868286bd9d8d909a762689` |
| `MossStudio-2.1.0-manga.1-linux-x64-portable.tar.gz` | 197 MB | `6968dd8ae21a2de951bcac198dbf43800564fb3c9d9baa2c527935d2b29eeb1b` |
| `MossStudio-2.1.0-manga.1-linux-x64-full.zip` | 195 MB | `0f4d33e3b68b26b4dd6748ca251442ed3c544d1a422b153e4723b47caeb2123f` |
| `files-2.1.0-manga.1-linux-x64.json` | 72 KB | `7bc2f96faf0e7bcc9f9d34de94211d5b2e24357fe2f4729aa027da64afb99cf2` |

- **Verification.** `verify-artifacts.mjs --version 2.1.0-manga.1 --platform linux-x64 --no-feeds` reports ok for the full zip (347 entries), the setup `.run` and the portable archive.
- **Smoke run.** The portable app was extracted and started with `--smoke` under `xvfb-run`, with `MOSSSTUDIO_DATA` set to a scratch folder so the user's data was not touched. It exits 0: the backend starts, the GPU is detected, and the catalog loads (22 models, 6 adapters). The `disk:error` check refers to the scratch folder on a 16 GB tmpfs, not to the build.

Windows and macOS were not built. They have to be packaged on those systems (`docs/how-to/release.md`).

## 5. Manual checklist (not yet run)

These need a real engine, model and language model, which the automated tests replace with fakes.

| # | Step | Expected |
| --- | --- | --- |
| 1 | Connect a language model in 创作 › 助手 › 连接设置 (OpenAI-compatible, Anthropic, Gemini or Ollama), then choose it in 漫画 › 设定 | It is listed under 用哪个语言模型 |
| 2 | 生成分镜 for a 6-page outline, with each provider kind | A storyboard arrives within the 180 s timeout; any warnings read sensibly; Ollama works without tools |
| 3 | 生成全部 on a chapter with LoRA and reference pictures | Jobs show in 活动 titled 「<漫画> 第 N 话 第 P 页 第 K 格」; pictures follow each panel's shape |
| 4 | Run on an engine without LoRA or references (兼容模式) | A notice says what was left out; the panel still draws |
| 5 | Stop the engine during a run | The panel retries three times, then shows 失败 with the reason; 再试一次 works |
| 6 | Quit the app while panels are queued and running, then reopen | Finished jobs are picked up; queued panels continue |
| 7 | The same character across several panels and chapters, with LoRA and reference | The face and outfit stay consistent (quality judgement) |
| 8 | 重画 with a note | The new picture follows the note; earlier takes stay selectable |
| 9 | Long Chinese lines, 心声, 喊叫 and 旁白, in both reading directions | Balloons wrap, stay inside the panel and do not cover faces too much |
| 10 | 导出这一话 | One PNG per page at 1456 × 2056 in `<folder>/<漫画名>/第N话-01.png`; pictures are not grey (clover:// loaded) |
| 11 | 写入剧情记忆, then storyboard the next chapter | The new storyboard keeps facts and the story so far |
| 12 | Delete a 漫画 | Its 漫画 · project disappears from 创作; pictures stay in 作品 |

## 6. Known limits

- Panels are drawn on this computer's engine only; remote hosts are not wired in.
- Balloons are placed by nine spots, not dragged.
- Export is PNG pages only (no PDF or CBZ).
- Balloon text in the small page preview is too small to read; it is legible at export size.
