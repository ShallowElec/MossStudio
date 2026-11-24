---
status: current
last-verified: 2026-11-20 (6d2ab54)
code: apps/desktop/src/main/services/loraProfiles.ts, apps/desktop/src/renderer/src/components/studio/LoraTriggerBar.tsx, apps/desktop/resources/models.json, apps/desktop/src/shared/modelCatalog.ts, apps/desktop/src/main/lib/content.ts, apps/desktop/src/shared/types.ts, apps/desktop/src/shared/bundleFit.ts, apps/desktop/src/shared/localBundle.ts, apps/desktop/src/shared/adapters.ts, apps/desktop/src/main/lib/paths.ts, apps/desktop/src/main/services/models.ts, apps/desktop/src/main/services/modelBundles.ts, apps/desktop/src/main/services/modelScan.ts, apps/desktop/src/main/services/modelImports.ts, apps/desktop/src/main/services/modelImport.ts, apps/desktop/src/shared/modelImport.ts, apps/desktop/src/main/services/modelFiles.ts, apps/desktop/src/main/services/controlAdapters.ts, apps/desktop/src/main/services/weightPrecision.ts, apps/desktop/src/main/services/modelSources.ts, apps/desktop/src/main/services/modelSourcePaths.ts, apps/desktop/src/main/services/modelSourceDiscovery.ts, apps/desktop/src/main/services/modelSourceServices.ts, apps/desktop/src/main/lib/localPath.ts, apps/desktop/src/shared/sharedModels.ts, apps/desktop/src/renderer/src/pages/models/, apps/desktop/src/renderer/src/components/ModelImport.tsx, apps/desktop/src/renderer/src/lib/modelImport.ts, apps/desktop/src/renderer/src/components/ModelDirectoriesCard.tsx
---

# Models

How MossStudio describes, downloads, finds and hands model files to the engine: the catalog of components and bundles, the models root, the person's own files brought in through 导入模型 (each one recognised by the engine) or found in another app's model folders, LoRA and control adapters, and the 模型 page. A job loads one file set, either a prepared diffusers folder or three component files, never a mix.

Paths in this doc are relative to `apps/desktop/src/` unless they start with `apps/`, `docs/` or `tools/`. Engine-side facts (what `load` and `inspect` accept) live in the [MossInfer repository](https://github.com/mossimage-cpp/mossimage.cpp); the engine packages and tiers are in [`engines.md`](/docs/reference/engines.md).

## 1. Catalog, components and bundles

The catalog is the list of everything the app can download or has found. Its schema is the set of types in [`shared/types.ts`](/apps/desktop/src/shared/types.ts): `ModelEntry` (one component), `AdapterEntry` (one LoRA), `ModelBundle` (a complete set), `ModelBinding` (the set a job runs with) and `Catalog`. The doc does not restate them.

| Term | Code | Meaning |
| --- | --- | --- |
| component, 部件 | `ModelEntry.role` | One downloadable or registered unit: `dit` 主模型, `text_encoder` 文本编码器, `vae` VAE, `support` (config files, never chosen by hand), `full` (a whole registered folder). `ModelEntry.choice` is the label 自己组合 shows (`MOSS-Image SFT INT8`); a folder and a single file of the same weights share one. |
| combination, 我的组合 | `ModelCombination`, `ModelBundle.custom` | A 主模型, 文本编码器 and VAE the person saved in 自己组合 (section 7). It is a bundle in the catalog like the others. |
| bundle, 模型包 | `ModelBundle` | A DiT, a text encoder and a VAE (`components`) plus a `support` entry with the pipeline and scheduler configs. The 模型 page calls a bundle a "model". |
| binding | `ModelBinding` | A bundle id with its three component ids, built by `bundleBinding()` in `main/services/modelBundles.ts`. This is what a job carries. |
| format | `ModelEntry.format` | `diffusers` (a folder with `config.json` per part) or `comfyui` (one `.safetensors` file). |
| precision | `ModelEntry.precision` | `bf16`, `fp16`, `fp32`, `int8`, `w4a8`, `mixed`; `local` for a scanned file until the engine reports it. |

Where the catalog comes from (`getCatalog` in `main/services/models.ts`):

1. On each full refresh the app fetches `apps/desktop/resources/models.json` from `main`, through the manifest mirror the network probe picked (GitHub raw or jsDelivr, `main/services/network.ts`). It uses the file only when `catalogProblems` in [`shared/modelCatalog.ts`](/apps/desktop/src/shared/modelCatalog.ts) finds nothing wrong (`source: 'remote'`), and saves it as `<data root>/cache/models.json`.
2. When `main` is unreachable or its file is rejected, the saved copy is used (`source: 'cache'`), unless its `updated_at` is older than the packaged catalog's.
3. Otherwise the copy packaged with the app is used (`source: 'builtin'`). A packaged app's `models.json` next to `app.asar` is this fallback, never an override.
4. In development the source tree's `models.json` wins over all of these (`source: 'local'`, `catalogOverrideDir` in `main/lib/content.ts`), so an edit shows at once.

So a model added to `models.json` on `main` reaches released apps without a release; [how-to/add-a-model.md](/docs/how-to/add-a-model.md) has the steps. Two rules keep an older app safe:

- **`min_app_version`** on a model, bundle (either list) or adapter hides it from older apps (`entriesForApp`), and a bundle with a hidden part is hidden too. A prerelease counts as its release (a nightly of 2.1.0 meets `2.1.0`) unless the minimum names a prerelease itself (`2.1.0-beta.2`).
- **`schema_version`** above `CATALOG_SCHEMA_VERSION` (3) is rejected, and such an app keeps its saved or packaged catalog. Raise it only when an older app would misread the file. A new optional field does not raise it: unknown fields pass. A file with `schema_version` below 2 is merged under the packaged one so it cannot reintroduce whole-repository downloads.

After a merge that changes the file, `.github/workflows/catalog.yml` purges jsDelivr's copy; GitHub raw caches it for about five minutes.

The shipped catalog (`schema_version: 3`) has two kinds of bundles:

- **Folder bundles** (`bundles`): `moss-sft` (recommended) and `moss-base`. Both share `qwen35-encoder`, `flux2-vae-small` and `moss-pipeline`, so switching between them downloads only the DiT.
- **Single-file bundles** (`single_file_bundles`): MOSS-Image SFT INT8, MOSS-Image Base INT8 (both `Comfy-Org/MOSS-Image`), MOSS-Image SFT INT4, MOSS-Image SFT NVFP4 and MOSS-Image SFT Turbo INT8 8 步. Each is a `format: 'comfyui'` DiT file, the INT8 text encoder file, the FLUX.2 small VAE file and `moss-runtime-config` (`RUNTIME_CONFIG_ID` in `shared/bundleFit.ts`: about 20 MB of configs and tokenizer). Files added for these bundles are pinned to the revisions the engine tested; a file downloaded earlier from `main` still counts as installed (`installMatchesRevision`).

The other `Comfy-Org/MOSS-Image` single files (W4A8, the Full VAE) are used through combinations (自己组合, below). `getCatalog` appends `single_file_bundles` and then the saved combinations to `bundles`, so the app sees one list. Older app versions read only `bundles` and never offer a single-file bundle they cannot load. A schema-2 catalog fetched remotely gets the built-in single-file bundles and their components added.

Bundle fields beyond the components (`ModelBundle` in `shared/types.ts`):

| Field | Meaning |
| --- | --- |
| `certified` | Listed in the engine's supported models (MossInfer `docs/integration.md`). The 模型 page shows certified bundles under 推荐模型 and the rest under 其他模型. |
| `tier` | The engine tier the bundle runs with: `high` for INT8, `turbo` for INT4 and NVFP4. It applies when the engine cannot name the weights' precision (section 4.4). |
| `requires` | Hardware it needs: NVFP4 runs only on compute capability 12.0 (RTX 50). Automatic GPU assignment waits for a GPU that matches. |
| `recommendedFor: 'limited-vram'` | Picked instead of the official SFT on a GPU with less than 16 GB of VRAM (`bestBundleFor` in `shared/bundleFit.ts`, also used by first-run setup). |
| `defaults` | Steps and CFG a few-step model brings when Studio picks it (`samplingForBundle` in `renderer/src/pages/studio/defaults.ts`): Turbo uses 8 steps and CFG 1. |

Names: `name` is the whole name as plain text, used in toasts, errors, job names and by older app versions; it never contains "·". `variant` lists the words at its end that tell a model from its family (`["INT8"]`, `["INT8", "8 步"]`, `["FP16-fixed"]`). The UI shows the rest of the name followed by those words as tags (`ModelName` in `renderer/src/components/common/ModelName.tsx`, `nameParts` in `shared/modelName.ts`); a name that does not end with its variant words is shown whole. Components carry `variant` the same way (`["INT8", "ConvRot"]`).

Which GPU can run which bundle is decided in one place, `bundleGpuProblem` in `shared/bundleFit.ts`, shared by job start, the 模型 page and Studio.

Catalog entries get their installed state from an install record (section 3), from a registered diffusers folder (section 4.3), from the person's own copy of a single file (section 4.2) or, for `provider: 'local'` entries, from the file still being where it was registered. The catalog is cached per models root and directory settings and invalidated by every download, import or delete (`invalidateCatalog`).

Which bundle a job uses: a 画面 (`kind: 'layout'`) stores only `modelBundleId` (`ProjectCanvas` in `shared/types.ts`). `resolveBundle` in `renderer/src/pages/studio/readiness.ts` takes the canvas's bundle, else the last one picked (`localStorage` key `mossstudio.modelBundleId`), else the recommended installed bundle, else the first installed one. `useGenerate.ts` sends `modelBinding: { bundleId, ...components }` with the job.

## 2. The models root and directories

| Path | Code (`main/lib/paths.ts`) | Default |
| --- | --- | --- |
| models root, 模型文件夹 | `paths.models(settings.modelsRoot)` | `<data root>/models`; `Settings.modelsRoot` overrides it |
| role folder | `paths.roleRoot(role, …)` | `moss/` (dit), `text-encoder/`, `vae/`, `support/`; `full` is the root itself; `Settings.modelDirectories[dit \| textEncoder \| vae \| support]` overrides one role |
| download cache per role | `paths.roleHub(role, …)` | `<role folder>/hf/hub/models--<owner>--<repo>/` in the Hugging Face layout: `blobs/`, `snapshots/<sha>/`, `refs/<revision>` |
| LoRA, LoRA文件夹 | `paths.adapters(…)` | `<models root>/adapters/<adapter id>/`; `modelDirectories.adapters` overrides it |
| registrations | `paths.modelImports(…)` | `<models root>/imports/index.json` |
| prepared bundles | `join(paths.models(…), 'bundles')` | `<models root>/bundles/<content key>/` (section 4.4) |

Folders are created only when something is written to them, and only inside the data root (`ensureDirs`). A folder the person pointed at, such as a ComfyUI `models` tree, never gets an empty `hf/hub` created in it; 清理空文件夹 (`cleanupEmptyModelDirs`) removes the empty `hf/hub` and `hf` folders older versions left behind, and nothing else.

Where this is set in the UI: the models root in 设置 › 存储 › 模型文件夹 (`renderer/src/pages/settings/StorageSection.tsx`; a change applies to new downloads, nothing is moved); the per-role folders in 模型 › 高级 › 文件夹 (`ModelDirectoriesCard.tsx`: 主模型文件夹, 文本编码器文件夹, VAE文件夹, LoRA文件夹, 运行配置文件夹, each with 更改 and 恢复默认).

## 3. Downloads

A download is one `DownloadTask` per component or adapter (`DownloadState`: `queued`, `running`, `verifying`, `paused`, `done`, `error`, `canceled`). `installBundle(id)` queues a task for each component of a bundle that is not installed; the 模型 page's 下载 button on a bundle calls it. Pause aborts the request and keeps the partial file; 继续 and 重试 start the task again and resume from the partial file.

The 下载 tab shows one row per model, not per task (`downloadGroups` in `renderer/src/pages/models/logic.ts`, `DownloadQueue.tsx`): a task for a bundle's DiT names the row, and the tasks of its other parts join it; a part or LoRA downloading on its own is a row of its own. 暂停 and 取消 act on every unfinished task of the row; 继续 and 重试 on a model row call `downloadBundle`, which re-queues every missing part. The parts fold out under the bar, finished ones as 完成. The tab's count is the number of rows.

Every download progress block on the 模型 page (featured card, model rows, 下载 rows, LoRA rows) is `DownloadProgress` over a `ProgressInfo` (`progressInfo`, `bundleProgress`, `taskProgress`): state words and percentage on top, a `ProgressBar size="md"`, then the amount (or what went wrong) on the left and speed and time left (or what is left) on the right, each a separate item. The bar's tone is the state: `accent` while queued, downloading or checking, `muted` when paused or disconnected, `danger` after an error.

| Step | Code | Behaviour |
| --- | --- | --- |
| Endpoint | `endpoint()` in `models.ts` | `Settings.hfEndpoint`, else the host the network probe picked (`hf-mirror.com` is preferred in 自动 and 镜像 mode, `huggingface.co` in 直连), else `https://huggingface.co`. |
| File list | `resolveFiles` in `modelFiles.ts`, `fetchHf` in `hfNetwork.ts` | Resolves the revision to a commit and lists files with sizes and LFS hashes. If the local request fails, the same URL is fetched through an SSH host (`Settings.hfQueryHostId`, 查询失败时改用远程主机). |
| Credentials | `hfCredentials.ts` | A token saved in 设置 › 网络 › 访问令牌（Token） is encrypted with Electron `safeStorage` into `<data root>/hf-credentials.json` and sent as `Authorization: Bearer`. Saving is refused when the OS offers no encrypted store (Linux `basic_text`). |
| Transfer | `downloadFile` in `modelFiles.ts` | Writes `<blob>.part`, resumes with a `Range` header, rejects a mismatched `Content-Range`, restarts on HTTP 416, verifies the size and the SHA-256 against the LFS hash, then renames into `blobs/`. `Settings.modelDownloadConcurrency` (同时下载的文件数, 1 to 16, default 4) limits parallel files. |
| Reuse | `runModelDownload` | Before requesting bytes, a blob with the same hash is hard-linked from any other repository cache under the models root, or copied from a registered file whose SHA-256 an older version recorded (`verifyImportedModelFile`). Imports no longer hash. |
| Space | `assertFreeSpace` in `main/lib/disk.ts` | Checked on the target role folder for the missing bytes plus 1 GiB, with 10 % to spare. |
| Record | `InstallRecord` in `models.ts` | `.clover-<id>.json` next to `blobs/` lists the files and which blobs this entry owns; `.clover-<id>.json.pending` holds the same while a download runs; `refs/<revision>` gets the commit. `installState` is `partial` while a record (final or pending) or a snapshot file exists but the files are not complete. |
| Validation | `validateSnapshot` in `modelFiles.ts` | A component counts as installed only when every file has its size, `config.json` exists for the part, every shard named in a `*.index.json` exists, and a text encoder has its tokenizer. |

Deleting a component (`deleteModel`) removes the prepared bundles that contain it, then only the blobs this record owns and no other record shares; it refuses while a download or a job runs. The UI plans a bundle delete with `bundleDeletePlan` (`logic.ts`): parts another complete bundle still uses are kept and named in the confirm.

Remote hosts (`Settings.remoteHostsEnabled`): the 模型 page's 模型所在的电脑 picker switches to an SSH host. Downloads then run on the host through `main/services/remoteModelWorker.sh` (`remoteDownloads.ts`), continue after MossStudio closes, and the host's inventory (`remoteModels.ts`) decides what is installed. Files are deleted per entry on the host (`remoteModelDelete.ts`). A Worker host whose service names `features.models` or `features.downloads` lists, deletes and downloads its models through the service instead, and the 模型 page offers it the catalog's single-file models too ([Worker hosts](/docs/reference/engines.md#worker-hosts-experimental)). 远程主机 in general is described in [`engines.md`](/docs/reference/engines.md).

## 4. Local models

The person's own files are used where they are, never copied or moved: files and folders brought in through 导入模型 (4.1), registered in `imports/index.json` (4.2), and the folders of other apps (4.5). The person's folder is never written to.

### 4.1 导入模型

`startModelImport` in `main/services/modelImport.ts` takes the paths of files and folders dropped on the window or picked in 导入模型 › 选择文件… / 选择文件夹… (`Ipc.modelsImport`, `Ipc.modelsImportPick`). One import runs at a time; paths added meanwhile join it. Its state (`ModelImportState` in `shared/types.ts`) goes to every window with `Events.modelImport` after each file, and `Ipc.modelsImportState` returns it to a window opened later.

| Path | What happens |
| --- | --- |
| A network place (`isNetworkPath`) | Allowed only when picked in the dialog (section 4.5); a dropped one is refused (`problem: 'network'`). |
| A file without a weights extension (`MODEL_FILE_EXTENSIONS` in `shared/modelImport.ts`) | Refused as not a model file, without asking the engine. |
| A drive root or the home folder | Refused (`isTooBroadModelFolder`). |
| The folder of a ComfyUI, Stable Diffusion WebUI or Forge install, or its `models` folder (`installationKind` in `modelSourcePaths.ts`) | Added as a shared source (section 4.5) and scanned at once. |
| A diffusers folder (`inspectDiffusersFolder`) | Read by the app: `diffusersFolderProblem` in `modelSources.ts` (a MOSS-Image `model_index.json`, not FP16, with its runtime configs), then registered as in section 4.3. |
| Any other folder | `scanModelDirectory` (with the limits of section 4.3), and each weights file and diffusers folder it finds. |
| A weights file | The engine's `inspect`, below. |

Every weights file goes to the engine's `inspect` ([MossInfer `server-protocol.md` § inspect](https://github.com/mossimage-cpp/mossimage.cpp/blob/main/docs/server-protocol.md#inspect)) through one sidecar (`withEngineRequests` in `main/lib/probeEngine.ts`), two at a time: the engine answers `busy` to a third. Answers are cached per engine binary, path, size and mtime. `recognize` in `shared/modelImport.ts` reads `kind`, `loadable`, `precision`, `quantization` and `note`:

| The engine says | The file becomes |
| --- | --- |
| `dit`, `text_encoder` or `vae`, loadable | A model part (`registerScannedModels` with the role, the precision and `inspected`). A file with the same name and exactly the same size as a catalog single file (`catalogFileMatch`) is recorded with that part's id as `catalogId` and stands in for it (section 4.2); the sheet says 认出来了：<catalog name>. A GGUF main model is a part too: the engine converts it on its first load ([MossInfer GGUF DiT files](https://github.com/mossimage-cpp/mossimage.cpp/blob/main/docs/integration.md#gguf-dit-files)). |
| `lora`, loadable | A LoRA used where it is (section 5). |
| `control_adapter`, loadable | A control adapter (section 6). |
| Anything else | Not usable, with one sentence from `importProblemText`. A file of `kind: 'unknown'` is not MOSS-Image, whatever its name says. For a DiT, text encoder or VAE the engine refused, the note (with the file's path taken out: the loader's note starts with it) names the version: FP16, FP8, NVFP4 without its kernels, an unsupported GGUF, a PyTorch pickle; a LoRA or control adapter for another model is said so. For FP16 and FP8 the INT8 single-file model of the same flavour is offered (`int8Instead`) while it is not here. |

Without a `moss-server` the files wait (`phase: 'waiting-engine'`), and `resumeModelImport` picks them up when an engine is installed (`Ipc.mossInferDownload` done, or engine auto-update). A computer whose GPUs run only a CLI engine (`deviceRunsCli`) has no engine to ask and reads no single file, so its files are refused (`problem: 'cli'`). A request that times out fails only its own file. Files dropped while the models are being made are checked before the import is done. Nothing more is checked, saved or downloaded once the app quits (`stopModelImport`).

When every file is checked, `assembleImport` in `shared/modelImport.ts` makes whole models of the parts. Each main model takes the text encoder and VAE that came with it; a part that did not come is taken from the certified single-file model that matches the main model (`matchingFileBundle`: the one it is part of, else the same precision and flavour, else the everyday INT8 model). When every part is a part of that certified model, the result is that model; otherwise a combination is saved (section 4.4) named `<catalog name>（我的文件）` or after the main model's file. Importing the same files again finds the same combination. With more than one text encoder or VAE, no model is made: the sheet opens 自己组合 with the first of each (`choose`). When a model's only missing part is the runtime config, it is downloaded at once (`installBundle`); otherwise its missing parts, the runtime config among them, wait for the sheet's download button.

`relocateBundle` (重新找到…, `Ipc.modelsRelocate`) needs an engine. It asks for each own file of a model that is not where it was, checks the picked file with `inspect` (it must be the same kind of part), and points the registration at it with the precision and tiers the engine names, keeping its id. Whether the file is a catalog part is asked again (`catalogFileMatch`): one that is not stops standing in, and a combination then uses the file itself. A gone shared file is replaced in the combination by the picked one. `forgetBundle` (移除, `Ipc.modelsForget`) drops the missing registrations and the combination; no file is touched.

### 4.2 Registering files

`registerScannedModels` in `main/services/modelImports.ts` writes one `ImportedModelFile` per path into `imports/index.json` (`schema_version: 2`): path, relative path, size, mtime, role, layout, and from 导入模型 the precision and a main model's `tiers` that `inspect` reported, `catalogId` and `inspected: true`. Nothing is hashed; the id is `local-scan-` plus the first 20 hex characters of the SHA-1 of the lowercased path. Registering the same path again updates the record. Every change to the index (register, relocate, remove) runs one at a time. A catalog part has one stand-in: a file registered for it takes it over from any other (`importedRecord` picks the last of several an older version left), and relocating or removing by the part's id acts on that one.

In the catalog these records become `ModelEntry` rows with `provider: 'local'`, `family: 'local'`, `format: 'comfyui'` for a file or `'diffusers'` for a folder, the recorded precision or `local` (a folder gets the dtype read from its first transformer shard), tags `local-import`, `unhashed` or `sha256:<hash>`, and `engine-checked` (`ENGINE_CHECKED` in `shared/modelCombos.ts`) for an inspected one. A record with a `catalogId` is not a row of its own: that catalog entry gets the file as its `localPath`, the tag `local-file`, and counts as installed; a combination saved with the record's own id before then names that catalog part instead, so it keeps working. An entry is installed while the file still has the registered size and mtime; otherwise it has `missingFile`: `changed` when it is there with another size or time, `drive` when the disk it was on is not there (its drive letter, or its folder under `/media`, `/mnt`, `/run/media` or `/Volumes`) and `file` otherwise (`missingPlace` in `main/lib/localPath.ts`). Removing an entry (移除) deletes the record only.

Records older versions wrote by hashing every file (`local-file-` plus the hash, with `sha256`) are still read, and a download still reuses their bytes (section 3). Nothing writes such records any more.

### 4.3 Diffusers folders used in place

导入模型 with a folder, and first-run setup's 使用已有模型 (the same sheet), register a complete diffusers folder where it is. `inspectDiffusersFolder` accepts a folder with `model_index.json` and a `config.json` plus `.safetensors` weights in each of `transformer/`, `text_encoder/` and `vae/`. The flavour (`sft` or `base`) is read from the README title or the folder name; the folder is listed as `MOSS-Image SFT（<folder>）` or `MOSS-Image Base（<folder>）`.

The folder is one `role: 'full'` entry, and `localFolderInstall` in `models.ts` also lets it stand in for the official components: entries of `OpenMOSS-Team/MOSS-Image-SFT` and `OpenMOSS-Team/MOSS-Image-Base` (`MOSS_REPOS`) count as installed when the folder passes `validateSnapshot` for that component. The DiT must be the same flavour; the text encoder, VAE and pipeline files are shared by both. Such a component shows the `local-folder` tag and its `localPath`. When a job prepares the bundle (section 4.4), the folder's files are hard-linked, or symlinked when a hard link is refused (`linkInPlace`), never copied.

`scanModelDirectory` in `main/services/modelScan.ts`, which 导入模型 runs over a folder, is read only. It walks up to 6 levels, 4000 files and 5000 folders for at most 30 seconds (`MAX_SCAN_DIRECTORIES`, `SCAN_TIME_LIMIT_MS`; the reason it stopped is in `skipped`), skips `.git`, `hf`, `blobs`, `snapshots`, `custom_nodes`, `controlnet`, `embeddings`, `upscale_models` and the other ComfyUI side folders listed in `skippedDirectories`, and reports every `.safetensors`, `.ckpt`, `.pt`, `.pth`, `.bin`, `.gguf` and `.onnx` file with a role guessed from its folder or name, and a folder that holds `model_index.json` as one candidate with `layout: 'diffusers-folder'`. The guessed role is used only by 模型 › 高级 › 文件夹: picking a per-role folder there (`ModelDirectoriesCard.tsx`) scans it and lists the candidates in 找到的模型文件 to register by that role, without `inspect`. 导入模型 uses the engine's answer instead.

### 4.4 How files reach the engine

`prepareModelSource(binding)` in `main/services/modelBundles.ts` turns a binding into what the engine can load, right before the job starts (`startEngineJobNow` in `main/services/supervisor.ts`). MossInfer's `load` always needs `model`, a folder with the configs and tokenizer; `dit_file`, `text_encoder_file` and `vae_file` each replace that part's weights in it, so any part mixes with any other.

| Parts in the binding | Result | Engine `load` payload (`main/services/mossInfer.ts`) |
| --- | --- | --- |
| Three folders (`format: 'diffusers'`) | `{ model: <prepared folder> }` with the bundle's `support` (`moss-pipeline`) | `model` |
| At least one single file (`format: 'comfyui'`, downloaded or the person's own) | `{ model: <prepared folder>, ditFile?, textEncoderFile?, vaeFile? }`: the folder holds `moss-runtime-config` plus the parts that are folders | `model` and a `*_file` per single file |

A prepared folder is `<models root>/bundles/<key>/`, where `<key>` is the first 24 hex characters of the SHA-256 of `clover_model.json` (bundle id, the folder's component ids, repositories, commits, precisions). `materializeBundle` builds it in a staging directory with hard links to the snapshot files (`materialize`: link, else copy after a free-space check) and renames it into place; a path two parts share is taken from the first. An existing folder with the same manifest and file sizes is reused. The layout is a diffusers model: `transformer/`, `text_encoder/`, `tokenizer/`, `vae/`, plus the support files at the root. For three folders, `prepareModelBundle` first checks the binding (`validateBinding`: every component `family: 'moss-image'` and either all `format: 'diffusers'`, or all `comfyui` with a `support` entry); a folder with the same key but another manifest is built beside it as `<key>-<8 characters>`. A single file is passed where it is: the person's file by its `localPath`, a downloaded one from its snapshot.

Combinations: `shared/modelCombos.ts` holds the rules (`slotChoices`, `supportFor`: `moss-runtime-config` once any part is a single file, else `moss-pipeline`; `combinationBundle`, which gives a combination with the person's own main model the `tier` and `requires` of its weights through `localDitNeeds` (from the tiers and precision `inspect` named; only a file registered before that is judged by its own file name, never its folders); `unusedDownloads`). `slotChoices` offers own files only when the engine recognised them in that role: inspected ones (`engine-checked`) and those of shared folders. `main/services/modelCombinations.ts` keeps them in `<data root>/model-combinations.json`, and `getCatalog` appends them to `bundles` with `custom: true`. When that file does not exist yet and the catalog has an installed local DiT, text encoder and VAE that were not inspected, the bundle older versions made by themselves (`localFilesBundle` in `shared/localBundle.ts`, id `local-files`) is saved once as the combination 电脑上的模型, so 画面 that use it keep working.

The local-files bundle: `localFilesBundle` in `shared/localBundle.ts` builds `ModelBundle` `local-files`, 本地文件（扫描）, from an installed local DiT, text encoder and VAE; `legacyLocalCombination` (`shared/modelCombos.ts`) is its only caller, which saves it once as the combination above. `localDitNeeds` gives it a `tier` (and `requires` for NVFP4) from the DiT's precision or file name.

A single file the person owns is passed by its `localPath` while it is installed (`prepareModelSource`); a catalog part standing in for it (`local-file`) is passed the same way. `installBundle` refuses a model with an own file that is not there (`E_MODEL_FILE_MISSING`, 找不到「…」的文件，请在「模型」页点「重新找到…」) instead of downloading something in its place.

Precision and tier: for component files `jobWeightPrecisions` (`main/services/weightPrecision.ts`) asks the engine's `inspect` what the DiT and text encoder are; `tierForWeights` in `shared/gpuProfile.ts` then settles the tier (an INT4 DiT runs Turbo, an INT8 DiT or INT8/W4A8 text encoder runs High). A prepared bundle folder counts as bf16. When the engine cannot name a file's precision (NVFP4, or an engine without `inspect`), the bundle's own `tier` decides instead (`profileForBundle` in `shared/bundleFit.ts`); either way the job records `source: 'model-weights'`. The CLI engines (兼容模式, AMD 原生) read only a prepared bf16 folder (section 8).

### 4.5 Shared model folders

Weights another app keeps (ComfyUI, Stable Diffusion WebUI, Forge, or any folder) are used where they are. A source (`ModelSource` in `shared/types.ts`, kept in `Settings.modelSources`) is an install, a models folder or a ComfyUI YAML config, added in 模型 › 共享模型目录 (`ModelSources.tsx`) or first-run setup's 使用已有模型. `main/services/modelSources.ts` turns the sources into catalog entries.

| Step | Code | Behaviour |
| --- | --- | --- |
| Roots | `sourceRoots` in `modelSourcePaths.ts` | The install's `models` folder; ComfyUI's `extra_model_paths.yaml` and `extra_models_config.yaml`; Comfy Desktop's `modelsDirs` and `basePath`; the `--*-dir` arguments in `webui-user.bat` and `webui-user.sh`, read and never run (a line over 8192 characters is skipped). Only `~`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `ProgramFiles` and `ProgramFiles(x86)` are expanded (`expandPathVariables` in `main/lib/localPath.ts`); a launch argument with another variable is dropped. |
| Local only | `isNetworkPath` in `main/lib/localPath.ts` | A network place (UNC and WebDAV shares, `\\?\`, `\\.\` and `\??\` paths, URLs) named by a config, reached through a link or found by discovery is skipped, and a source that names one says so (已跳过网络位置) without repeating the path. The last part of a path is read as a link before it is followed (`linksToNetwork`); a link higher up the path is caught only after `realpath` has resolved it, and is then skipped. Only a folder picked in the folder dialog, and what lies inside it, may be on the network. A drive root or the home folder is refused as a source (请选择具体的模型目录) and skipped as a root. |
| Overlap | `separateFromDownloads` in `modelSources.ts` | A root inside the models root or a per-role folder is skipped; a download folder inside a root is left out of that root's scan. So a per-role folder may point into a ComfyUI tree (section 2) and both keep working; the source says 已跳过与 Moss Studio 下载位置重叠的目录. |
| Scan | `scanModelDirectory(root, { shared })` | The walk of section 4.3 with its limits, plus: folder links are followed when the target is local, `diffusers` and `controlnet` are read, and the root's own name (`checkpoints`, `loras`) gives the role. |
| Check | `inspectWeight` in `modelSources.ts` | A `.safetensors`, `.sft` or `.gguf` file not checked at its current size and mtime goes to the engine's `inspect`, all through one sidecar (`withEngineRequests` in `main/lib/probeEngine.ts`: `ENGINE_HELLO_TIMEOUT_MS`, `ENGINE_INSPECT_TIMEOUT_MS`), and `recognize` reads the answer as 导入模型 does (section 4.1). A diffusers folder is read instead (`diffusersFolderProblem`). Anything else is `incompatible`, with the sentence `importProblemText` gives in `ModelSourceFile.reason` (listed under 不兼容的模型和 LoRA). A file the engine could not check stays `pending`, and the source shows why. |
| Entries | `sharedModels`, `sharedAdapters`, `sharedControlAdapters` | Id `shared-` plus the first 24 hex characters of the SHA-256 of the path (lowercased on Windows) (`SHARED_MODEL_PREFIX` and `isSharedModelId` in `shared/sharedModels.ts`), tag `shared-directory`. Main-model parts join the catalog's models, and a diffusers folder also becomes a bundle with the same id, which the model lists leave out; LoRAs join section 5's list and control adapters section 6's. None is deleted or removed by itself: 移除来源 drops the whole source and keeps every file. |

At job start `requireSharedWeight` checks the path, size and mtime the scan saw; a file that changed or is gone fails the job with a message that says which and asks for 自动扫描. A shared single file is passed like the person's own file (section 4.4). A shared diffusers folder is passed as `model` itself and nothing is prepared (`directFolder` in `prepareModelSource`). A file also registered through 导入模型 keeps both entries, so a combination saved with either id still runs; 自己组合 lists it once (`duplicatesImportedFile`). A combination whose shared file is gone loses that entry with the next scan; it stays listed as 找不到文件 (section 7).

Two caches, both in `<data root>/cache/` (`paths.sharedModelIndex`, `paths.modelSourceDiscovery`):

| File | Holds |
| --- | --- |
| `shared-models.json` | The engine key (`moss-server` path and mtime); per checked file its size, mtime and `inspect` answer; a snapshot of every source's status and usable weights, keyed by the sources and the download folders. |
| `model-source-discovery.json` | The suggested sources (kind and path) of the last discovery. Running apps are not saved. |

At start the snapshot is restored before the first catalog, and nothing is scanned. When there is no snapshot, or it was taken for other sources or download folders or by another engine, a scan runs in the background, the restored weights stay usable meanwhile, and `Events.modelsChanged` refreshes the windows when it ends. A new engine (installed by hand or by auto-update) and a change of 模型文件夹 or a per-role folder start the same background scan. 自动扫描, adding, moving and removing a source scan in the foreground.

Discovery (`nearbyModelSources` in `modelSourcePaths.ts`) reads the Comfy Desktop profiles (`desktopProfileLocations`) and looks one folder deep in Desktop, Documents, Downloads and Apps in the home folder, plus `~/Applications` and `/opt` on macOS and Linux, or on Windows `%LOCALAPPDATA%\Programs`, `ProgramFiles`, `ProgramFiles(x86)`, each fixed drive's Program Files folders and the Desktop and Documents known folders. On Windows one PowerShell query (`modelSourceDiscovery.ts`, its script on stdin, ended at quit) adds the install folders from the Uninstall registry keys (HKCU, HKLM and WOW6432Node) and from the Start Menu and Desktop shortcuts of these apps. Discovery does not read shell history, the Run box history, recent-file shortcuts, installer logs or the process list. 自动扫描 also asks ports 8188 and 7860 on `127.0.0.1` whether ComfyUI or WebUI answers (`modelSourceServices.ts`).

## 5. LoRA

A LoRA is an `AdapterEntry` (`kind: 'lora' | 'lycoris' | 'dmd'`) in the catalog's `adapters`, downloaded or local. Each one lives in `<adapters root>/<id>/`:

| Source | Code (`models.ts`) | Record |
| --- | --- | --- |
| Catalog download | `runAdapterDownload` | The repository files listed in the entry, then `adapter.json` (the entry itself). Installed when `adapter.json` and every file exist. |
| 导入模型 | `linkAdapterFile` | A file the engine's `inspect` calls a loadable LoRA (section 4.1) is used where it is: origin `linked`, `file` its path, id `lora-` plus the first 16 hex characters of the SHA-1 of the path (lowercased on Windows), so importing it again updates its row. Tag `local-file`; listed as 在原位置使用, and 移除 drops the row only. A moved file stays listed with 找不到文件, and a job using it fails at start as a missing LoRA does. |
| Copied by an older version | — | Origin `imported`, tag `local-import`: a copy in `<adapters root>/<id>/`. Still listed and used; 删除 removes the copy, never the original. |
| Shared model folder | `sharedAdapters` in `modelSources.ts` | A LoRA found in a shared source (section 4.5), used where it is; shown as 共享模型目录 with no 删除. |
| Trained in 训练 | `registerTrainedAdapter` | The checkpoint of the step the person keeps is copied in as `trained-<training id>`; origin `trained`, tag `trained`. Keeping another step registers the same id again and replaces the file ([training.md](/docs/reference/training.md#10-choosing-a-step-and-the-lora)). |

Local adapters are indexed in `<adapters root>/index.json` (`LocalAdapterIndex`). Deleting one removes its folder and its index row.

On the board a 风格 (`kind: 'style'`) or 画面 stores `adapters: CanvasAdapter[]`, ids and strengths only (`shared/adapters.ts`: strength 0 to 2, default 1, step 0.05, at most 16 per canvas, ids are single path segments). `resolveCanvasAdapters` (`main/services/adapterResolution.ts`) turns the ids into files at job start through `resolveAdapterFile`; a LoRA at strength 0 is off, neither required nor sent. A missing adapter fails the job with the message the Studio shows, it is never dropped silently. `kind: 'dmd'` adapters are not offered in the picker (`isSelectableAdapter` in `shared/adapters.ts`), since the `dmd8` sampling profile applies them. How the 风格 node uses LoRA is in [`studio-node-board.md`](/docs/reference/studio-node-board.md).

UI: 模型 › LoRA (`LoraTab.tsx`): 已安装 with 删除 (移除 for one used where it is), and 可以下载. Files come in through 导入模型; the Studio's LoRA picker (`AdapterPicker.tsx`) has 导入文件, which opens 导入模型 › 选择文件….

### 5.1 Trigger words

A LoRA row on a 画面 or 风格 shows its trigger words as chips (`components/studio/LoraTriggerBar.tsx`); a click writes the word into the description or takes it out (`addTrigger`, `removeTrigger` in `pages/studio/prompt.ts`, whole phrases only, so `sks` is not found in `tasks`). The pencil opens 编辑 LoRA 触发词: the words, a negative note, a recommended strength the picker uses when the LoRA is added, and 插入方式: 手动, or added before or after the description for every run (`applyLoraAutoTriggers`), each word once and only when the description does not already have it.

| Source | Where |
| --- | --- |
| The file | `extractSafetensorsTriggers` (`main/services/loraProfiles.ts`) reads only the safetensors header (at most 16 MiB): `modelspec.trigger_word`, `trigger_word` or `trigger_words`, else a `.civitai.info`, `.json` or `.txt` beside the file. The most frequent training tags (`ss_tag_frequency`) are offered as suggestions, never applied. Read once per file version (`cachedSafetensorsTriggers`, keyed by size and modification time); a network path is never opened |
| The person's choices | `<dataRoot>/lora-profiles.json`, one row per LoRA id (`loraProfileSchema` in `shared/schemas.ts`). Each row is checked on its own: a bad row is skipped, the others stay, and a file that could not be read as written is copied to `lora-profiles.json.damaged-<time>` before the next save replaces it |

`getCatalog` merges both into each local `AdapterEntry` (`mergeLoraMeta`). The renderer passes the profiles to `compileCanvasPrompt` as an argument; readiness compiles with the LoRA of the 画面's 风格 too (`adaptersWithStyles` in `pages/studio/nodes.ts`), and a run compiles `generationCanvas`, which already holds them, so the prompt shown is the prompt sent.


## 6. Control adapters

A control adapter (控制适配器) is the file that makes a 控制图 (role `control`) usable. `main/services/controlAdapters.ts` keeps them in `<data root>/control-adapters.json` as `ControlAdapterEntry` rows. 导入模型 registers a file there (`registerControlAdapter`) when the engine's `inspect` says `kind: 'control_adapter'` and `loadable: true`, with the `control_kinds` (for example `depth`, `canny`) and `base_model` it reports; any other file goes where its kind belongs (section 4.1). Adding the same file again, also through a link, updates its entry. Removing an entry drops the record; the file stays. Control adapters found in a shared source (section 4.5) are listed too, without 移除, unless a registered entry has the same path.

UI: 模型 › 控制适配器 (`ControlAdaptersSection.tsx`), with 移除 per entry; files come in through 导入模型. The section is hidden when the engine has no `control` feature and nothing is registered. A control port on the board asks for one before it accepts a wire (`renderer/src/pages/studio/ports.ts`).

## 7. The Models page

Route `/models`, Rail entry 模型, `renderer/src/pages/models/ModelsPage.tsx`. The header has the page's one primary action, 导入模型, a menu of 选择文件… and 选择文件夹… (local only). Tabs: 模型, LoRA, 下载 (with the number of models downloading). No line on the page joins pieces with "·": a row's size is a column of its own beside its action (`SizeText` in `ModelEntries.tsx`), kinds and precisions are `Tag`s, and the native selects of 自己组合 put the size in brackets (`MOSS-Image SFT INT8（15.4 GB，已下载）`). The import sheet's download button is the one exception the design asks for: 还缺文本编码器和 VAE · 下载 10 GB.

导入模型 (`components/ModelImport.tsx`, state in `lib/modelImport.ts`, view logic in `pages/models/importView.ts`) is mounted once in the main window: files dragged over the window from outside show a full-window layer (松开导入模型、LoRA 或控制适配器, with the count), and the drop opens the sheet. A place that takes file drags itself answers first and the layer stays away: the Studio board takes pictures as cards, sends model files and folders to the sheet, and refuses anything else with a toast and no copy cursor (`boardTakesDrag`, `sortBoardDrop` in `pages/studio/imageNodes.ts`). The sheet shows 正在识别 N 个文件… with a bar of N of M and a row per file (a spinner, then 模型, 模型的一部分, LoRA, 控制适配器 or 模型目录, or 用不了 with its sentence and its one way out); 在后台继续 closes it while the check goes on, and a toast says when it ends. Without an engine it says 装好引擎后才能认出这些文件 with 装引擎. At the end each model is 可以用了：<name> (在原位置使用，不占额外空间) only when `bundleView` says it is complete and `bundleBlocker` lets it run here, else its download button or why not; 去创作 sets it on the selected 画面 and as the last pick (`requestStudioModel`, `mossstudio.modelBundleId`) and opens 创作, 留在这里 closes the sheet. An NVFP4 main model is 用不了 on a computer without the GPU its catalog model `requires`, and every single file on one whose GPUs all run a CLI engine. First-run setup's 使用已有模型 opens the same sheet, with the shared model folders under its two buttons and 用这个模型 as the main action.

| Area | Component | Shows |
| --- | --- | --- |
| 我的模型 | `ModelList`, `CombinationDialog.tsx` | Every model that is here (the featured one excepted), each combination tagged 我的组合 (hidden on a remote host), and models whose own file is not where it was (`modelSections` in `logic.ts`). 自己组合 (local only) opens the dialog: 名字 and one select per slot (下载: each `choice` label once, the copy already here first, else the folder version; 电脑上的文件: own single files the engine recognised in that role), counts 还要下载 and saves with 下载并保存 or 保存. Deleting a combination removes the downloads only it needs, never the person's files (`DeleteModelDialog`). |
| 推荐模型 | `FeaturedModel` in `ModelEntries.tsx`, then `ModelList` | The bundle that suits this computer first (`bestBundleFor`), with the reason, name, description and total size and one main action: 下载, 暂停, 继续 or 重试; 可以使用 and 去创作 when installed. Below it every other `certified` bundle not in 我的模型. A bundle this GPU cannot run says why; a paused or failed download of it can still be continued or retried. |
| 其他模型 | `ModelList` | Bundles that are not `certified` and not in 我的模型 (the shipped catalog has none); hidden when empty. |
| 共享模型目录 | `ModelSources.tsx` | Local only. The sources with their path and problems (更换路径, 移除来源), the suggestions to 接入, 添加来源 (ComfyUI, Stable Diffusion WebUI, Forge, 自定义目录) and 自动扫描, which also says which of these apps is running. |
| 可用模型 | `ModelsTab` in `ModelsPage.tsx` | The main-model parts found in the sources, and under 不兼容的模型和 LoRA (closed at first) the files the engine cannot use, each with its reason. |
| 控制适配器 | section 6 | Local only. |
| 存储位置 | `StorageRow` | 模型文件夹 with 打开模型文件夹 and 在 设置 › 存储 中更改; on a host, 模型保存在 … 上. |
| 高级 | `AdvancedPanel.tsx` | 文件夹 (`ModelDirectoriesCard`) and 没有用到的文件 (downloads no bundle or combination needs, `unusedDownloads`, with 查看 and 全部删除), or on a host `<host name> 上的文件夹` (模型保存目录, 生成时使用的模型文件夹 with 自动查找, 下载完整的默认模型). |

State texts come from `bundleView` and `itemState` in `logic.ts`: 可以使用, 下载中 N%, 正在校验文件, 已暂停, 下载没有完成, 还差 N 个文件, 未下载, 已下载, 已添加, 找不到原文件, 文件不完整 (action 修复), and 找不到文件 for a model whose own file is not where it was (`status: 'lost'`, from `isLostOwnFile` and `goneOwnPart` in `shared/modelImport.ts`): it offers no download, only 重新找到… and 移除, and says where the file was (`lostFileText`: 插上那块硬盘，或重新找到它 when its disk is missing). Studio blocks 生成 for such a model with the same sentence and 重新找到…, which opens `/models?bundle=<id>` (`deriveReadiness` in `pages/studio/readiness.ts`). Files the app downloaded are 删除d; registered files are 移除d from the list. Deep links take `?bundle=<id>&component=<role>&hostId=<id>&tab=models|lora|downloads` (`parseModelsQuery`); first-run setup uses them to point at the model with the missing part.

## 8. Limits

None of these is planned work; they describe what the code does today.

- A combination's own file must be a single file (`format: 'comfyui'`); a registered diffusers folder is a whole model (section 4.3), not a slot choice.
- A combination is not edited in place: it is deleted and built again.
- Own files are checked by size and mtime, not hashed, so they cannot be matched to a Hugging Face blob or reused by a download. A file is taken for a catalog part by its name and exact size (and the engine's role), never by its hash.
- A registered diffusers folder serves only `OpenMOSS-Team/MOSS-Image-SFT` and `OpenMOSS-Team/MOSS-Image-Base` components (`MOSS_REPOS`). An FP16-fixed folder registers as a 完整模型 entry but stands in for no bundle, and first-run setup does not count it as a ready model.
- The FP16-fixed DiTs (`KBlueLeaf/MOSS-Image-FP16-fixed`) are in no bundle and not offered in 自己组合 (`isFp16Dit` in `shared/bundleFit.ts`): the engine reads a DiT only in bf16 or a quantized format ([MossInfer supported models](https://github.com/mossimage-cpp/mossimage.cpp#supported-models)). Their four entries stay in the catalog so a copy downloaded by an older version shows under 没有用到的文件 and can be deleted.
- A combination saved with an FP16-fixed 主模型 before that stays in the list as 用不了 with the reason, is blocked in Studio, refused at job start and never picked by first-run setup (`bundleWeightProblem` in `shared/bundleFit.ts`). An own FP16 file brought in through 导入模型 is refused there with the engine's reason; one registered by an older version or through 模型 › 高级 › 文件夹 was not inspected, so it still fails at load with the engine's error. Once the combination is deleted no model uses the FP16 file, so a copy still on disk shows under 没有用到的文件.
- 导入模型 shows no progress for a GGUF main model's first conversion: the engine converts it in the first load and reports it only as `dit_load` progress without a fraction ([MossInfer GGUF DiT files](https://github.com/mossimage-cpp/mossimage.cpp/blob/main/docs/integration.md#gguf-dit-files)); the sheet says it takes longer the first time.
- The runtime config (`moss-runtime-config`, about 20 MB) is downloaded, never shipped with the app, so a model of own single files needs the network once.
- Single-file bundles and combinations with a single file run only on this computer's moss-server; a Worker host is offered the catalog's single-file bundles and fails on its side if it cannot load one. An SSH host running moss-server uses its own model folder, and a GPU running a CLI engine refuses them with the reason the 模型 page and Studio also show.
- The CLI engines refuse any `format: 'comfyui'` component (so a combination with a single file) and any non-bf16 DiT or text encoder (`cliBundleProblem` in `shared/cliEngine.ts`; `cliBundleDtypeProblem` reads the shard dtypes of a prepared folder).
- SSH hosts running moss-server take no LoRA (`resolveCanvasAdapters` refuses when `hostId` is set); a Worker host takes only LoRA from its own list (`resolveRemoteWorkerAdapters` in `main/services/remoteWorker.ts`). Remote hosts show no combinations and no control adapters; 自己组合 is local only.
- Shared model folders serve only this computer: remote hosts and SSH engines cannot use their files (`isLocalOnlyBundle` in `shared/bundleFit.ts`). A Worker host is also refused the person's own imported files (`bundleBlocker` in `renderer/src/pages/models/logic.ts`). A CLI engine takes a shared diffusers folder only when it is bf16, and no shared single file.
- 导入模型 needs an engine that answers `inspect` for weight files; `withEngineRequests` refuses one whose `hello` says `inspect: false` (请更新 MossInfer 后检查模型文件), and its files are then refused as not checked (`check-failed`).
