---
status: proposed
date: 2026-11-16
amends: ADR-0002, ADR-0008, ADR-0011
---

# ADR-0015: Training runs in the main window and the trainer window is retired

## Context and problem statement

ADR-0002 (section 0) put LoRA training in its own "Kohaku Trainer (External)" window, ADR-0008 (decision 1) kept two `BrowserWindow`s, `studio` and `trainer`, and ADR-0011 let that part stand ("Windows"). The trainer window was a form over the trainer's command line: a weights path, a dataset path, an algorithm and a list of numbers, with the result left as a file in a run folder. The 训练 page in the rail only listed runs and opened that window. A person had to prepare a trainer version by hand, know what the numbers meant, and carry the result into 模型 and 创作 themselves. The question: where does training live, and how much of the trainer does the app show?

## Decision drivers

- The app is for people who have never trained a model. They know their pictures and what they want the model to learn, not rank, alpha and learning rate.
- ADR-0011 moved every other feature into one window with a rail; training was the last one that lost its context in a second window.
- A trained LoRA is only useful once it is in 模型 and on the board.
- The trainer stays an external tool with its own Python environment and license (ADR-0002); nothing of it enters this repository.
- A person's pictures must not leave the computer without them asking.

## Considered options

1. Keep the trainer window and improve its form.
2. One flow on the `/training` page of the main window, built around a training (`TrainingProject`) that owns its pictures; the trainer's plumbing moves to 设置 › 训练.
3. Put training on the Studio board as a node.

## Decision outcome

Chosen option: 2, as the design review settled. Option 1 keeps the split context and the command-line form. Option 3 mixes a job of minutes to hours, with its own data set, into a board that [refuses to be a training front end](../explanation/studio-design.md).

As built on `feat/training-redesign`:

1. **One window.** `WindowKind` in `apps/desktop/src/main/windows.ts` is `'studio'` only. The `/trainer` route, `pages/TrainerWindow.tsx` and the `trainer:run` channel are removed. `window:open` with `kind: 'trainer'` opens `/training` in the main window, so old intents still land.
2. **One flow.** `/training` shows first use, the list, or one training: editor, run, result ([training.md](../reference/training.md)). First use prepares the base model, the trainer and its environment with one action. Trainer versions, the environment, folders and download sources live in 设置 › 训练, listed only while `Settings.trainingEnabled` is on.
3. **Presets first.** 学什么 (人物, 画风, 物品) and 训练多久 pick a recipe (`presetRecipe` in `apps/desktop/src/shared/training.ts`); 高级 holds every knob and the commands to copy.
4. **Result by looking.** The run draws sample pictures per step beside the untrained base. The person picks a step, and that checkpoint is registered as the LoRA `trained-<training id>`. 在创作中试用 puts it on the board.

Related decisions from the same review:

- **Automatic descriptions go through the connected 语言模型.** 自动写描述 sends each picture to the provider the person connected for the 助手 (`apps/desktop/src/main/services/training/captions.ts`). Pictures leave the computer only through that action, which the person starts. The trigger word is the fallback: the copy of the pictures a run reads gives a 人物 or 物品 picture without a description the trigger word as its description, and puts the word in front of a description that lacks it (`runCaption` and `stageDataset` in `training/dataset.ts` beside it). The person's own descriptions are never rewritten. No captioning model is bundled or downloaded.
- **Training uses MOSS-Image Base.** A local run takes the installed `moss-base-int8` bundle, linked into the ComfyUI layout the trainer reads, and falls back to bf16 `moss-base`; when neither is installed, preparing downloads the INT8 one (`BASE_BUNDLE_IDS` in `training/readiness.ts`, `training/weights.ts`). Turbo and other bundles are not offered as a base.
- **Full finetune is not offered.** The app offers the LyCORIS algorithms in `TRAINING_ALGOS`. A full finetune does not produce a LoRA, so it has no place in a flow that ends in 模型 › LoRA.
- **Samples default to on, except on small cards.** A new training samples every 250 steps unless the card has 8 GB of memory or less (`judgeMachine` in `training/readiness.ts`); the person can change it under 高级.

### Consequences

- Good: training is reachable like every other page, keeps its place while other pages are shown, and its jobs, notifications and results use the same Activity panel, 模型 and board as the rest of the app.
- Good: a first training needs pictures and two choices. The result is chosen by eye and is usable in 创作 in one click.
- Good: one window less to create, test and document. The `windows`, `trainer-remote-artifact` and `trainer-remote-job` scenarios of `apps/desktop/src/main/index.ts` are removed with it.
- Bad: people who trained through the old form lose its one-off actions (`inspect_data`, `cache_text`, `cache_latents`, `export`, `sample` as separate jobs). The run does the caches itself; 复制训练命令 under 高级 gives the commands for the rest.
- Bad: a training copies its pictures into the data root, which uses disk twice for large data sets.
- Bad: automatic descriptions depend on a 语言模型 that can read pictures; with a hosted provider the pictures go to that provider.
- Bad: the window no longer carries the trainer's name. The credit line (`pages/training/TrainerCredit.tsx`, on first use and in 设置 › 训练) names Kohaku Trainer and links its license; whether that satisfies the naming clause ADR-0002 section 2 describes is for the maintainer to confirm.

## More information

- Amends [ADR-0002](0002-trainer-backend.md), section 0: the trainer no longer appears as its own window. The external-process boundary stands.
- Amends [ADR-0008](0008-studio-window-and-dock.md), decision 1 and the consequence "训练 UI 保留独立窗口": one window, `studio`.
- Amends [ADR-0011](0011-rail-navigation-and-node-board.md), the "Windows" bullet. The rail, Activity panel and board stand.
- Reference for the result: [docs/reference/training.md](../reference/training.md).
- The trainer and its knobs: [KohakuMossTrainer](https://github.com/KohakuBlueleaf/KohakuMossTrainer).
