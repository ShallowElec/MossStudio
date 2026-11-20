---
status: current
last-verified: 2026-11-16 (cfbc64e)
code: apps/desktop/src/shared/training.ts, apps/desktop/src/shared/channels.ts, apps/desktop/src/main/services/training/, apps/desktop/src/main/ipc.ts, apps/desktop/src/main/lib/paths.ts, apps/desktop/src/renderer/src/pages/training/, apps/desktop/src/renderer/src/pages/settings/TrainingSection.tsx, apps/desktop/src/renderer/src/lib/studioTry.ts
---

# Training

训练 turns a folder of pictures into a LoRA. A training (`TrainingProject`) owns a copy of its pictures and descriptions, runs [KohakuMossTrainer](https://github.com/KohakuBlueleaf/KohakuMossTrainer) as one job, shows sample pictures per step, and registers the step the person keeps as the LoRA `trained-<training id>`. This doc is the as-built reference: files on disk, states, channels, how a run is composed, and the screens.

Paths are relative to `apps/desktop/src/` unless they start with `apps/` or `docs/`. The feature is optional (`Settings.trainingEnabled`, 设置 › 功能 › 训练) and lives in the main window ([ADR-0015](/docs/decisions/0015-training-in-the-main-window.md)). The trainer stays an external tool ([ADR-0002](/docs/decisions/0002-trainer-backend.md)); what its knobs mean is in its own docs, not here.

## 1. Where the code lives

| Part | File | Holds |
| --- | --- | --- |
| Contract | `shared/training.ts` | Types, `trainingSchemas` (zod), presets (`presetRecipe`, `lengthOf`, `triggerFrom`) |
| Channels | `shared/channels.ts` | `Ipc.training*`, `Events.trainingChanged`, `Events.trainingReadinessChanged` |
| Store | `main/services/training/store.ts` | `project.json` read and write, one write queue per training (`keyedQueue`, `whileEditable`), create, patch, duplicate, remove |
| Pictures | `training/dataset.ts` | Copying pictures in, problems (`small`, `duplicate`), `.txt` descriptions, the folder a run reads (`stageDataset`) |
| Descriptions | `training/captions.ts` | 自动写描述 through 设置 › 语言模型 › 助手和漫画 |
| Readiness | `training/readiness.ts` | What a computer has for training, and `prepareTraining` |
| Base weights | `training/weights.ts` | The `--weights` folder of a local run |
| Commands | `training/commands.ts` | The script of one run (pure functions) |
| Run | `training/run.ts` | Start, stop, job end, choosing a step, the handlers behind the channels |
| Samples | `training/samples.ts` | Reading a run folder: samples, checkpoints, the remote copy |
| Failure | `training/failure.ts` | A log tail to a reason in plain words |
| Trainer versions | `main/services/trainers.ts`, `trainerGit.ts`, `trainerEnv.ts`, `remoteTrainer.ts` | The git mirror, versions and Python environments; the `trainer:*` channels |
| Jobs | `main/services/supervisor.ts` | `startTrainingJob`, step and loss parsing (`trainerMetrics`), `stopTrainingJobs` on quit |

## 2. Data on disk

`<data root>` is described in [architecture.md](/docs/reference/architecture.md#the-data-root). `paths.training()` is `<data root>/training`.

| Path | Content | Written by |
| --- | --- | --- |
| `training/<id>/project.json` | The `TrainingProject`, written atomically | `store.ts` |
| `training/<id>/images/` | Copies of the pictures (`.png`, `.jpg`, `.jpeg`, `.webp`) with a same-stem `.txt` description each: the trainer's `folder_nl` layout | `dataset.ts` |
| `training/<id>/dataset/` | What a run reads, rebuilt at each start: the pictures hard-linked (copied where a link cannot be made) and the descriptions the run trains on (section 6) | `dataset.ts` (`stageDataset`) |
| `training/<id>/configs/<run>.py`, `<run>_data.py` | The run's train and data configs, written through `--out` | the trainer's `kohakumoss-config` |
| `training/<id>/run.sh` or `run.ps1` | The script of the last local run | `run.ts` (`startLocal`) |
| `training/<id>/cache/` | The trainer's text and latent caches (`CACHE_DIR`) | the trainer |
| `training/<id>/runs/<run>/samples/step_XXXXXXXX/NNN.png` | One picture per sample prompt, in prompt order; `settings.json` is written last | the trainer |
| `training/<id>/runs/<run>/checkpoints/step_XXXXXXXX/export/<run>-comfy.safetensors` | The LoRA of that step | the trainer |
| `training/<id>/runs/<run>/export/<run>-comfy.safetensors` | The LoRA of a finished run | the trainer |
| `training/<id>/runs/<run>/remote.json` | Remote runs only: the steps that have a checkpoint on the host | `samples.ts` (`syncOnce`) |
| `training/<id>/download/step_XXXXXXXX/` | Remote runs only: a LoRA copied from the host, deleted once registered or when the copy fails | `run.ts` (`exportFile`) |
| `<models root>/training-weights/moss-base-int8/` | Links to the INT8 base parts under the file names the trainer looks for (`COMFY_WEIGHT_FILES`) | `weights.ts` |
| `<adapters root>/trained-<id>/` | The saved LoRA ([models.md](/docs/reference/models.md#5-lora)) | `registerTrainedAdapter` in `main/services/models.ts` |
| `trainer/` | The trainer's git mirror, versions and runtimes | trainer services |

An id is `tp-<time>-<random>` (`newTrainingId`). A run is named `<trigger or kind>-<last id part>`, with `-2`, `-3` on later runs of the same training (`nextRunName`).

The `clover://` protocol serves pictures under `training/` to the renderer (`studioPicturePath` in `main/services/gallery.ts`), which is how thumbnails and samples are shown.

## 3. The training and its states

`TrainingProject` in [`shared/training.ts`](/apps/desktop/src/shared/training.ts) is the schema. `state` moves like this:

| State | Means | Leaves by |
| --- | --- | --- |
| `draft` | Being set up. The only state that accepts `training:update` (`E_TRAINING_NOT_DRAFT` otherwise) | `training:start` → `starting` |
| `starting` | The run's pictures are being prepared or uploaded and the job is being started. No job yet | The job starting → `running`; any failure → back to `draft`, with the error thrown to the caller |
| `running` | Its job is queued, starting or running | The job ending |
| `done` | The job succeeded. The last step is saved as the LoRA automatically | Nothing; `training:start` refuses (`E_TRAINING_DONE`) |
| `stopped` | The job was canceled. Checkpoints so far can be chosen | `training:start` runs it again under the next run name |
| `failed` | The job failed, or the app closed while it ran. `failure` says why | `training:start`, as above |

- The UI starts only a draft. On a result it offers 再训练一次, which is `training:duplicate`: a new draft with the same pictures, descriptions and settings.
- While `starting` or `running` (`isBusy` in `store.ts`) a training is locked: changes to settings, pictures and descriptions are refused with `E_TRAINING_RUNNING`, and so are removing it, starting it again and saving a step.
- One queue per training serialises every write: `project.json` (`mutateTrainingProject`) and the pictures and descriptions (`whileEditable`). A start marks the training `starting` through the same queue, so an edit either lands before the start or is refused.
- A busy training whose start or job is gone is settled when it is listed or read (`settle` in `run.ts`). `starting` with no start in this process (the app closed during it) becomes `failed`. `running` follows its job's end state, or becomes `failed` with the "interrupted" reason when the job is gone. A remote run's end needs the host, so the list does not wait for it.
- `saveError` and `saveErrorStep` record a save that failed and the step it tried (section 10). A `project.json` written before `saveErrorStep` existed reads as `null`.
- `present` adds the live step of a running job and `cover` (the chosen step's first sample, else the newest) before a training reaches the renderer.

## 4. Recipes and presets

A `TrainingRecipe` holds the knobs the app sets. Two choices pick one (`presetRecipe`):

| 学什么 (`kind`) | Algorithm | Dim, alpha, LR | Steps at 标准 |
| --- | --- | --- | --- |
| 人物 (`person`) | `lokr` | The trainer's own values (`null`) | 3000 |
| 画风 (`style`) | `lora` | 32, 32, `1e-4` | 1500 |
| 物品 (`object`) | `lora` | 16, 16, `1e-4` | 2000 |

训练多久 (`length`) scales the steps: 快速 `fast` × 0.5, 标准 `standard` × 1, 精细 `fine` × 1.5, rounded to 250. Every preset uses `batch` 1, resolution 1024 and `vram: 'auto'`. `batch` is shown as 梯度累积 and sets the trainer's gradient accumulation (section 8). `sampleEvery` is 250, or 0 where samples default to off (section 7).

- A changed knob under 高级 makes `length` `custom` (自定义) unless the recipe still equals a preset (`lengthOf`).
- A new `kind` or `length` in a patch brings that preset's recipe and keeps `sampleEvery`; sample prompts follow the kind and trigger for as long as they are still the defaults (`applyTrainingPatch` in `store.ts`).
- `trigger` is ASCII (`[A-Za-z0-9_]`, at most 32), derived from the name by `triggerFrom`, and empty for 画风.
- `TRAINING_ALGOS` is `lora`, `lokr`, `loha`, `dora`, `oft`. A full finetune is not offered.

## 5. Channels and events

Every channel validates its payload with `trainingSchemas` and is registered in `main/ipc.ts`.

| Channel | Payload → result | Handler |
| --- | --- | --- |
| `training:readiness` | `{ hostId }` → `TrainingReadiness` | `trainingReadiness` |
| `training:prepare` | `{ hostId }` → `TrainingReadiness` at that moment; the work continues in the background | `prepareTraining` |
| `training:list` | → `TrainingProject[]`, newest first | `trainingList` |
| `training:create` | `{ kind, hostId? }` → a draft | `trainingCreate` |
| `training:get` | `{ id }` → `TrainingProject` | `trainingGet` |
| `training:update` | `{ id, patch }` → `TrainingProject` | `trainingUpdate` |
| `training:remove` | `{ id }`. Deletes the training folder and, best effort, its folder on the host. A saved LoRA stays | `trainingRemove` |
| `training:duplicate` | `{ id }` → a new draft | `trainingDuplicate` |
| `training:dataset` | `{ id }` → `TrainingDataset` | `scanDataset` |
| `training:dataset-add` | `{ id, paths }` (files or folders) → `TrainingDataset` | `addToDataset` |
| `training:dataset-remove` | `{ id, names }` → `TrainingDataset` | `removeFromDataset` |
| `training:caption-set` | `{ id, name, caption }` → `DatasetImage`; an empty caption removes the `.txt` | `setCaption` |
| `training:caption-auto` | `{ id, names? }` → `TrainingCaptionResult` | `autoCaption` |
| `training:command` | `{ id }` → the script of the next run, as text | `trainingCommand` |
| `training:start` | `{ id }` → `TrainingProject` once its job exists (`running`, or already settled). `starting` is announced by `event:training-changed` before the call answers | `trainingStart` |
| `training:stop` | `{ id }` → `TrainingProject` | `trainingStop` |
| `training:samples` | `{ id }` → `TrainingSamples` | `trainingSamples` |
| `training:choose-step` | `{ id, step }` → `TrainingProject` | `trainingChooseStep` |
| `training:reveal` | `{ id }`. Shows the saved LoRA, else the run folder, in the file manager | `trainingReveal` |

| Event | Payload | Sent when |
| --- | --- | --- |
| `event:training-changed` | `TrainingProject` | A training changes state or its saved step: starting, back to a draft after a failed start, running, ended, a step saved or not saved |
| `event:training-readiness` | `TrainingReadiness` | Preparing moves to another step or ends |

Progress, loss and the log of a run come from its job (`event:job`, the Activity panel), not from these events. `window:open` with `kind: 'trainer'` opens `/training` in the main window.

`trainer:remove` and `trainer:remote-remove` refuse with `E_TRAINER_IN_USE` while a training is starting or running on that trainer version (`trainerVersionInUse` in `run.ts`).

## 6. Pictures and descriptions

- `addToDataset` copies files, or every picture inside folders, into `images/`. A sidecar `.txt` comes along. Names are made unique by stem, without case. A file that is not a readable picture is skipped.
- `scanDataset` reports each picture's size and problems: `small` when the shorter side is under `SMALL_PICTURE_SIDE` (512), `duplicate` when an earlier picture has the same content hash. Problems inform; they do not block a run.
- Every change to `images/` (add, remove, a description, 自动写描述) runs in the training's write queue and is refused while it is starting or running (`whileEditable`).
- 自动写描述 (`autoCaption`) asks the 助手和漫画 model of 设置 › 语言模型 (`languageProvider` in `shared/ai.ts`, `askAboutImage` in `main/services/ai.ts`) for one short Chinese sentence per picture, three at a time, 60 s each. By default it covers the pictures without a description. A picture over 3.5 MB is sent as a JPEG of at most 1536 px. This is the only path on which training pictures leave the computer.
- `TrainingCaptionResult.error` is set when nothing was written: no provider, a provider that cannot read pictures, or every request failed. "Cannot read pictures" is a 4xx answer whose message says so in one of the phrasings of `NO_IMAGE_INPUT` in `main/services/ai.ts`; it raises `E_NO_IMAGE_INPUT` and stops the batch. Any other error counts as one failed picture. The provider is then marked `noImageInput`, so 设置 › 语言模型 stops calling it 能看图 until its model or address changes.
- With no language model connected, 自动写描述 does not call main: the click opens the connect dialog titled 自动写描述要用语言模型 and runs once a model is connected (`useModelGate` in `components/common/ProviderDialog.tsx`). A `TrainingCaptionResult.error` still shows under the pictures with 连接语言模型 next to it.
- A run never trains on `images/` directly. Each start rebuilds `dataset/` (`stageDataset`): every picture linked in, with the description `runCaption` gives it. For 人物 and 物品 that is the trigger word alone when the picture has no description, and the trigger in front when the description does not name it as a word of its own (`mentionsTrigger`). For 画风 it is the description as written, and no `.txt` when there is none. The person's own `.txt` files in `images/` are never rewritten.
- GBC 打标 (`pages/training/GbcLabel.tsx`) is the second way to write descriptions: a scope of the pictures with no description or all of them, one confirmation over ten pictures with the cost warning, the same `startGbcJob` as the Studio (destination `training`, so 自动 means Chinese), and a review of each suggestion: the picture, an editable caption (the graph's short caption), 跳过, 全部接受, 接受并继续. It reads with 设置 › 语言模型 › 看图; with no model that sees pictures, the click asks for one first (打标要用语言模型). Only an accepted caption is written, through `training:caption-set`; a picture that already had a description says 替换 and is never overwritten in passing. Each graph is also kept as `training/<id>/gbc/<stem>.json` for later use; the trainer still reads only the `.txt`.

## 7. Readiness and preparing

`trainingReadiness(hostId)` answers a `TrainingReadiness`. `ready` needs all of: no `blockReason`, the base model installed, a trainer version whose environment is ready, enough disk, and no prepare running.

| Field | Rule (`readiness.ts`) |
| --- | --- |
| `blockReason` | `mac` on macOS; `no-nvidia` without an NVIDIA card; `low-vram` under `MIN_TRAINING_VRAM_BYTES` (6 GB). Local runs use the NVIDIA card with the most memory |
| `ramLow` | A warning: under 32 GB of RAM with a card under 16 GB |
| `baseModel` | Local: `moss-base-int8`, else `moss-base`, whichever is fully installed (`installedBaseBundle`); `missingBytes` is the INT8 download. Remote: whether `TrainingHost.weightsPath` holds the weights |
| `trainer` | `ready` when a version has `status: 'ok'` and `runtimeState: 'ready'`; `installing` and `error` follow the prepare |
| `disk` | Free space at `training/` (local) or `trainerRoot` (remote) against the missing download plus 8 GB for a run, plus 12 GB while the environment is not installed |
| `samplesByDefault` | False when the card has 8 GB or less |

`prepareTraining` runs once per host at a time and reports through `event:training-readiness` (`prepare.step`: `model`, `trainer`, `environment`):

| Step | Local | Remote |
| --- | --- | --- |
| `model` | Downloads the `moss-base-int8` bundle through the model downloads, in parallel with the trainer steps | Nothing is downloaded; the person sets 底模文件夹 on the host. A missing path ends the prepare with `WEIGHTS_MISSING` |
| `trainer` | Creates a version at the stable tag, else the default branch's newest commit | Creates a version on the stable branch, else the default one |
| `environment` | `installTrainerRuntime`: PyTorch first, then the trainer. Only Windows needs a PyTorch index of its own (PyPI's Windows wheel is CPU only; its Linux wheel already uses CUDA, its macOS wheel MPS): `torchIndexes` offers the CUDA indexes the NVIDIA driver runs, newest first (the oldest alone for a driver too old for all, the oldest first when its age is unknown), and the install takes the first that carries a version the trainer pins (they carry different ranges: cu128 stops at 2.11). 设置's PyTorch source or backend overrides this. The index used is kept on the environment (`TrainerRuntimeInfo.torchIndex`); a ready environment from another source, or an older Windows one on an NVIDIA machine, counts as not installed and is replaced (the old one is deleted once no version uses it). When nvidia-smi does not answer, nothing is replaced, and a CUDA build is kept where nothing particular is wanted (it also runs on the CPU). The download goes out as `prepare.packages` (`PackageInstallProgress`, read from pip or uv output by `main/lib/packageProgress.ts`), also while the base model still downloads | `remoteInstallRuntime` (Linux hosts, where PyPI's wheel already uses CUDA) |

Other versions, the Python path, the PyTorch and pip sources and the trainer folder are in 设置 › 训练 (section 12).

## 8. How a run is composed

`trainingStart` (`run.ts`) refuses a training that is busy or done, marks it `starting` and announces that, then runs `launch`. `launch` refuses a training without pictures, at a host that is not ready, or at a host that already has a live training job (`E_TRAINING_BUSY`: one run per host). It then resolves every path into a `TrainingCommandPlan` (`preparePlan`, which links the local weights into place), builds `dataset/` (section 6), writes the script and starts one job with `startTrainingJob`. A failure anywhere in `launch` returns the training to `draft`. Once the job exists the training becomes `running`; a job that ended before its id was saved is settled right then.

The script is built by [`trainingScript`](/apps/desktop/src/main/services/training/commands.ts) from `trainingSteps`. It changes into the trainer version's folder, puts `<version>/src` first on `PYTHONPATH` (`versionSourceDir`: versions that share an environment must load their own checkout, not the one installed last), and runs four commands, stopping at the first that fails:

| # | Command | Purpose |
| --- | --- | --- |
| 1 | `kohakumoss-config new train --weights … --data <dataset> --source folder_nl --algo … --name <run> --steps … [--vram N] --prompt … --out <configs>/<run>.py --force` | Writes `<run>.py` and `<run>_data.py` into the training's `configs/` (`configFiles`), not into the trainer checkout |
| 2 | `kogine run scripts/data/cache_text.py --config <configs>/<run>_data.py --set …` | Text cache |
| 3 | `kogine run scripts/data/cache_latents.py --config <configs>/<run>_data.py --set …` | Latent cache |
| 4 | `kogine run scripts/train/moss.py --config <configs>/<run>.py --set …` | Training |

The `--set` knobs come from `dataKnobs` and `trainKnobs`. The recipe maps to `TARGET_AREA` (resolution squared), `GRAD_ACC` (from `batch`), `DIM`, `ALPHA`, `LR`, `SAVE_EVERY`, `SAMPLE_EVERY` and `SAMPLE_AT_START`; `KEEP_LAST=0` and `CHECKPOINT_EXPORT=true` are always set so every step stays choosable. The `KEY=VALUE` lines of `recipe.overrides` come last, so they win. What each knob does is documented by the trainer: [KohakuMossTrainer](https://github.com/KohakuBlueleaf/KohakuMossTrainer) (its first-LoRA guide and config reference).

| Shell (`plan.shell`) | Script | Started as |
| --- | --- | --- |
| `posix` | `run.sh` | `bash run.sh`, in the version folder |
| `powershell` | `run.ps1`, with a BOM and `powershellArg` quoting. It checks each command's exit code and does not set `$ErrorActionPreference = 'Stop'`, which would end the run on the trainer's first stderr line | `powershell.exe -File run.ps1` |
| `remote` | `<remote dir>/run.sh`, which writes `run.pid` | `ssh … setsid -w bash run.sh` |

A local run sets `CUDA_DEVICE_ORDER=PCI_BUS_ID` and `CUDA_VISIBLE_DEVICES` to the chosen card. `training:command` returns the same script for copying (复制训练命令). It writes and links nothing: the weights folder is only named (`plannedWeightsFolder` in `weights.ts`).

The run ends through `onTrainingJobEnded`, which `main/index.ts` hooks to `onJobCompleted`:

| Job state | Training becomes | Then |
| --- | --- | --- |
| `succeeded` | `done` | The last step is saved (`trainingChooseStep`) and a notification 训练完成 opens `/training` |
| `canceled` | `stopped` | `stepReached` is the job's step or the newest checkpoint, whichever is later |
| `failed` | `failed` with `failure` | A notification 训练没有完成. For a remote run the stop command is sent first (section 12) |

停止 is `cancelJob`. On app quit `stopTrainingJobs` ends every running training (the local process tree, or the remote stop command), and the next start marks it interrupted.

## 9. Samples and checkpoints

- With `sampleEvery > 0` the trainer draws every sample prompt at step 0 (训练前, the untrained base) and every `sampleEvery` steps, and saves a checkpoint at the same steps. With `sampleEvery` 0 there are no samples and a checkpoint every `DEFAULT_CHECKPOINT_EVERY` (500) steps.
- `listSamples` (`samples.ts`) reads the run folder into `TrainingSamples`: `columns` (a step and its pictures; a step folder counts only once its `settings.json` exists, which the trainer writes after the pictures), `checkpoints` (steps whose export file exists; the last step also counts when the finished run's own export is there) and `nextStep` while running.
- The renderer reads `training:samples` again every 15 s while a running training is on screen (`RunViews.tsx`).
- `pages/training/sampleGridModel.ts` turns this into grid columns: drawn steps, checkpoints without samples, and the steps still to come with their time left.

## 10. Choosing a step and the LoRA

`trainingChooseStep(id, step)` works on any training that is not busy and has a run. Saves of one training run one at a time (`saves`, a `keyedQueue`), since they share the adapter and the download folder:

1. Finds the file: `checkpoints/step_XXXXXXXX/export/<run>-comfy.safetensors`, or `export/<run>-comfy.safetensors` for the last step (`exportCandidates`). A remote file is copied into `download/step_XXXXXXXX/` first.
2. Registers it with `registerTrainedAdapter` as `id: trained-<training id>`, named after the training, `kind: 'lora'`, `license: 'local'`, `base` the installed base bundle. Registering the id again replaces the weights, so a training has one LoRA whichever step is kept.
3. Writes `chosenStep` and `adapterId` and clears `saveError` and `saveErrorStep`. A failure writes `saveError` and `saveErrorStep` instead and keeps the earlier choice.

In the result view (`savedLora` in `pages/training/trainingModel.ts`) the LoRA counts as saved whenever `adapterId` is set, so a later failed save of another step does not take 在创作中试用 away. 重试 saves `saveErrorStep` again.

在创作中试用 (`ResultView`) puts a `StudioTryRequest` (`lib/studioTry.ts`) in the store and navigates to `/studio`. The Studio takes it once and calls `tryLoraOnBoard` ([studio-node-board.md](/docs/reference/studio-node-board.md#10-lora-and-the-风格-node)).

## 11. Failure reasons

`trainingFailureReason` (`failure.ts`) reads the last 120 log lines of the job. The first rule whose pattern appears wins, in this order: GPU out of memory, host out of memory, disk full, no usable GPU or driver, incomplete environment, lost SSH connection, permission denied, cache miss, missing file. Anything else is `GENERIC_FAILURE`, which points at the job log. A job with `E_INTERRUPTED` gets the "interrupted" reason without reading the log. The wording lives in that file.

## 12. Remote training

A training's `hostId` is `local` or an SSH host (`TrainingHost`, [engines.md](/docs/reference/engines.md)). Remote training needs `Settings.remoteHostsEnabled`.

| Step | What happens (`run.ts`, `samples.ts`) |
| --- | --- |
| Layout | `<trainerRoot>/training/<id>/` on the host holds `dataset/`, `configs/`, `runs/`, `cache/`, `run.sh`, `run.pid`; versions and runtimes are under `<trainerRoot>/versions/` and `runtimes/` |
| Weights | `TrainingHost.weightsPath` (底模文件夹 in the host dialog, `pages/settings/HostDialog.tsx`): a ComfyUI models folder or an HF folder. Nothing is uploaded or downloaded for it |
| Busy check | Before a start, `remoteBusyCommand` looks at every `training/*/run.pid` under the trainer root. A pid that is still a live `run.sh` refuses the start with `E_TRAINING_BUSY`: a run whose SSH session dropped keeps going in its own session |
| Start | `dataset/` on the host is removed and the local `dataset/` uploaded with `scp` (30 min limit), the script is written over SSH, and the job is the `ssh` process |
| Stop | The job's `cancelCommand` is `remoteStopCommand`: it kills the process group named in `run.pid`. The same command is sent when a remote job ends as `failed` (`stopRemoteRun`), so a dropped connection does not leave the trainer running |
| Samples | `syncRemoteRun` lists finished sample folders and checkpoints in one SSH call, copies new sample folders into the local `runs/<run>/samples/` (through a `.part` folder) and writes `remote.json`. It runs on `training:samples` and when the job ends |
| Saving | The chosen step's file is copied down with `scp` (10 min limit), then registered as in section 10 |
| Remove | The host folder is deleted, best effort |

## 13. Screens

The route is `/training`, and `/training/<id>` for one training; `pages/Training.tsx` re-exports `pages/training/TrainingPage.tsx`. What shows is decided by `homeView` and `projectView` in `pages/training/trainingModel.ts`.

| Screen | Shown when | File |
| --- | --- | --- |
| Blocked | `readiness.blockReason` is set. Says why, offers 用另一台电脑训练 | `FirstUse.tsx` (`Blocked`) |
| First use | No trainings and not ready. The checks (显卡, 内存, 底模, 训练环境, 空间), 准备训练, then 先选图片 while preparing | `FirstUse.tsx` (`FirstUse`), `trainingModel.ts` (`checkRows`) |
| 想教模型什么？ | Ready with no trainings, or after 新建训练 | `Home.tsx` (`StartTiles`) |
| List | There are trainings. Starting and running ones first as wide cards | `Home.tsx` (`HomeList`), `trainingModel.ts` (`homeCard`) |
| Editor | A draft. 学什么, 名字, 触发词, 训练多久, 高级, the pictures, 开始训练. Every change saves itself | `Editor.tsx`, `editorModel.ts`, `Pictures.tsx` |
| 高级 | Inside the editor. Every recipe knob, 样图, 位置, 复制训练命令 | `RecipeFields.tsx` |
| Running | `starting` (pill 准备中, 正在准备图片…) and `running` (pill 训练中). Progress, time left, loss curve, the sample grid as it fills; 停止 and 查看日志 once the job exists | `RunViews.tsx` (`RunningView`), `runModel.ts` (`runPill`, `runProgress`) |
| Result | `done`, `stopped`, `failed`. The sample grid to choose a step from, 在创作中试用, 再训练一次, 在文件夹中显示, 删除 | `RunViews.tsx` (`ResultView`) |
| Sample grid | In the run and result views. A row per sample prompt, a column per step, 训练前 first | `SampleGrid.tsx`, `sampleGridModel.ts` |
| 设置 › 训练 | `/settings/training`, listed while `trainingEnabled` is on. The trainer's version and environment, 位置与下载, 远程电脑, other versions under 高级, the credit line | `pages/settings/TrainingSection.tsx`, `pages/training/TrainerSection.tsx`, `TrainerAdvanced.tsx`, `TrainerCredit.tsx` |

Hooks for the page are in `pages/training/useTraining.ts` (`useTrainingHost`, `useReadiness`, `useTrainings`). The list and first use follow the selected location; one training follows its own `hostId` for 位置 and readiness (`ProjectScreen` in `TrainingPage.tsx`). A start that fails brings the editor back with the reason beside 开始训练.

## 14. Tests

| Covers | Where |
| --- | --- |
| Main services | `apps/desktop/test/main/services/training/`, `apps/desktop/test/main/services/remoteTrainer.test.ts` |
| Renderer models | `apps/desktop/test/renderer/training/`, `apps/desktop/test/renderer/studio/tryLora.test.ts` |
| The fake main process | `apps/desktop/test/mocks/backend/training.ts` |
| E2E | `apps/desktop/e2e/specs/training.e2e.ts` |
