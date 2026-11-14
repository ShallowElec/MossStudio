---
status: record
date: 2026-11-13
---

# 漫画 character consistency, 2026-11-13

Two chapters of one series were drawn through the real Studio with a character portrait as a vision reference, then redrawn with the same seeds in controlled variations. The portrait keeps the face consistent; it also carries over whatever else is in it. A line about where the balloons go made the engine draw balloons of its own, so it was removed.

## Setup

RTX 4070 Laptop GPU (8 GB), MOSS-Image SFT INT8, Qwen3.5-9B INT8 text encoder with the vision tower, MossInfer 2.2.1 with vision references (`v2.2.1-vision.2`, CUDA 13), 1280 × 816 panels, 20 steps, CFG 3. Series 一致性测试: 阿秋 (portrait reference, two outfits) and 莲 (text only), two chapters of two pages, 12 panels (rainy night harbour, office, sunny shopping street, café, rooftop at night), with wide, full, medium, close and extreme shots.

## Run through the Studio

All 12 panels were drawn in about 15.5 minutes (about 78 s each) with no failure. The queue resumed after the page was reloaded, and both chapters were approved and exported. With the portrait, 阿秋's face, hair and glasses matched in every panel and the outfit changed where asked.

## Findings

| # | Finding | Variation that showed the cause | Outcome |
| --- | --- | --- | --- |
| 1 | Most panels drew gibberish balloons, with or without the portrait | Same seed, no portrait, the description line 构图：右上留出空白放对白，人物的脸不要放在这些位置 removed: no balloon in any of three panels | Removed the line (`balloonRoomHint`); the description never mentions balloons. Negative description unchanged (文字，对白框，水印). Test: `test/shared/manga/prompt.test.ts` |
| 2 | With the portrait, 阿秋 squatted in most panels, and the sunny day and the rooftop became rainy nights | The portrait was cropped from a panel of her squatting in the rain. Same seeds without it: the poses and scenes followed the descriptions. Weight 0.5 changed nothing visible | A portrait carries its pose and scene with the face |
| 3 | With a clean portrait (front, head and shoulders, plain white background, weight 1.0) there was no squatting and no rain, and the face matched best, but wide and full shots became head-and-shoulders close-ups, with the described figure repeated small in the background | Same three panels and seeds | Open: the portrait also carries its framing. Next to try: a lower weight or no portrait for wide and full shots |
| 4 | Up to four panels ran at once, while the reference says two | `nextToSubmit` limits each chapter, and the queue sends for every chapter | Open |

## Not covered

LoRA, an engine without vision references, other language models, more than one referenced character in a panel.
