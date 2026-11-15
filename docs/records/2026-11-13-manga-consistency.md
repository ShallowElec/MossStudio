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
| 3 | With a clean portrait (front, head and shoulders, plain white background, weight 1.0) there was no squatting and no rain, and the face matched best, but wide and full shots became head-and-shoulders close-ups, with the described figure repeated small in the background | Same three panels and seeds | The portrait also carries its framing. See below |
| 4 | Up to four panels ran at once, while the reference says two | `nextToSubmit` limited each chapter, and the queue sent for every chapter | The limit counts the whole series. Test: `test/shared/manga/queue.test.ts` |

## Sizing the portrait by shot

Same seeds, the clean portrait, no balloon line. Each picture goes into the prompt as about one token per 32 × 32 pixels.

| Variation | Wide and full shots (harbour, street, rooftop, running) | Medium and close shots (footprints, office, phone, café, crowd) |
| --- | --- | --- |
| `weight` 0.3 or 0.6 (100000 px) | No visible change from 1.0: close-ups instead of wide shots. The engine fades the picture toward gray, which does little to a black and white line portrait | not tried |
| 100000 px (engine default) | Close-ups, the figure repeated small behind | Faces match; the close shot in a crowd lost the crowd to the portrait's white background |
| 50000 px | not tried | Faces match, poses and scenes follow the description, the crowd is back |
| 25000 px | Full figures, poses and scenes as described, short hair and glasses kept | Scenes follow, the face drifts more (hair) |

So `REFERENCE_PIXELS` sends 25000 px for wide and full shots, 50000 for medium and close shots and 100000 for extreme close-ups, and the card asks for a front-facing portrait on a plain white background.

## Run through the Studio again

With the changes above (`1995a7a`) and the clean portrait, the same 12 panels were drawn through the Studio in about 15.5 minutes, again with no failure, never more than two at a time. Each job carried the size for its shot. No panel drew a balloon. 阿秋's face, hair and glasses matched in all 12, the wide and full shots showed her full figure, and the scenes followed the descriptions (rainy harbour, sunny street, moonlit rooftop). One running panel set at night came out in daylight. The pages showed a 。 alone on a balloon's last line; `wrapText` now keeps closing punctuation on the line before (`test/shared/manga/balloons.test.ts`).

## A weight that works

MossInfer's `weight` faded the picture toward gray, which a black and white line portrait hardly notices. The engine fork (`fb80399` on `feat/vision-references`) makes it blend the predictions with and without the pictures, and adds a step window. Same seeds, clean portrait at 100000 px:

| Variation | Wide and full shots | Close shots | Time per panel |
| --- | --- | --- | --- |
| weight 1 | Close-ups (bit for bit the earlier engine) | Faces match | 70 s |
| weight 0.7 | Mostly as described; the rooftop wide shot still became a close-up | Faces match | 107 s |
| weight 0.5 | All as described, short hair and glasses kept | Faces match, the crowd stays | 107 s |
| window from 0.3 or 0.5 | Like no portrait at all | Faces drift as without one | 70 s |

The face is set in the early steps, so a late window does not help. Sizing by shot (25000 px for wide and full shots) looks as good as weight 0.5 and costs nothing extra, so it stays the default; 参考强度 on the card lowers the weight for a character whose picture still pulls too hard.

## Not covered

LoRA, an engine without vision references, other language models, more than one referenced character in a panel.
