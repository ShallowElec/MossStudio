/**
 * The commands of one training run, as KohakuMossTrainer documents them (docs/guides/first-lora.md):
 * write the configs, build the offline text and latent caches the base config asks for, then train.
 * Pure: the caller resolves every path, so the same text runs and is shown for copying.
 */
import { DEFAULT_CHECKPOINT_EVERY, type TrainingRecipe } from '@shared/training'
import { posixQuote } from '../ssh'

/** posix: a local bash script; powershell: a local Windows script; remote: bash over SSH. */
export type TrainingShell = 'posix' | 'powershell' | 'remote'

export interface TrainingCommandPlan {
  shell: TrainingShell
  /** The trainer version (a KohakuMossTrainer checkout); commands run from its root. */
  versionDir: string
  configBin: string
  kogine: string
  /** A ComfyUI models folder or an HF folder with the MOSS-Image Base weights. */
  weights: string
  /** The training's pictures with their `.txt` descriptions. */
  data: string
  /** OUTPUT_DIR: the run lands in `<outputDir>/<runName>/`. */
  outputDir: string
  cacheDir: string
  runName: string
  recipe: TrainingRecipe
  /** Remote only: the file the script writes its pid to, so 停止 can end it. */
  pidFile?: string
}

/** `KEY=VALUE` lines of the 高级 overrides; blank lines and `#` comments are skipped. */
export function overrideLines(overrides: string): string[] {
  return overrides
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line))
    .map((line) => line.replace(/^([A-Za-z0-9_]+)\s*=\s*/, '$1='))
}

/** Knobs for the cache passes: they key on the same data knobs as training, so a mismatch would miss. */
export function dataKnobs(plan: Pick<TrainingCommandPlan, 'cacheDir' | 'recipe'>): string[] {
  return [`CACHE_DIR=${plan.cacheDir}`, `TARGET_AREA=${plan.recipe.resolution ** 2}`, ...overrideLines(plan.recipe.overrides)]
}

/** Knobs for the train pass. Overrides come last so the person's own lines win. */
export function trainKnobs(plan: Pick<TrainingCommandPlan, 'cacheDir' | 'outputDir' | 'recipe'>): string[] {
  const { recipe } = plan
  const sampling = recipe.sampleEvery > 0
  return [
    `OUTPUT_DIR=${plan.outputDir}`,
    `CACHE_DIR=${plan.cacheDir}`,
    `TARGET_AREA=${recipe.resolution ** 2}`,
    `MICROBATCHES=${recipe.batch}`,
    ...(recipe.dim === null ? [] : [`DIM=${recipe.dim}`]),
    ...(recipe.alpha === null ? [] : [`ALPHA=${recipe.alpha}`]),
    ...(recipe.lr === null ? [] : [`LR=${recipe.lr}`]),
    `SAVE_EVERY=${recipe.sampleEvery || DEFAULT_CHECKPOINT_EVERY}`,
    // Every checkpoint stays (the default keeps 3), so any step can be chosen afterwards.
    'KEEP_LAST=0',
    'CHECKPOINT_EXPORT=true',
    `SAMPLE_EVERY=${recipe.sampleEvery}`,
    ...(sampling ? ['SAMPLE_AT_START=true'] : []),
    ...overrideLines(recipe.overrides),
  ]
}

/** Each command as its program and arguments, in the order they run. */
export function trainingSteps(plan: TrainingCommandPlan): string[][] {
  const { recipe, runName } = plan
  const config = [
    plan.configBin,
    'new',
    'train',
    '--weights',
    plan.weights,
    '--data',
    plan.data,
    '--source',
    'folder_nl',
    '--algo',
    recipe.algo,
    '--name',
    runName,
    '--steps',
    String(recipe.steps),
    ...(recipe.vram === 'auto' ? [] : ['--vram', recipe.vram]),
    ...recipe.samplePrompts.flatMap((prompt) => ['--prompt', prompt]),
    '--force',
  ]
  const sets = (knobs: string[]): string[] => knobs.flatMap((knob) => ['--set', knob])
  const dataConfig = `configs/user/${runName}_data.py`
  return [
    config,
    [plan.kogine, 'run', 'scripts/data/cache_text.py', '--config', dataConfig, ...sets(dataKnobs(plan))],
    [plan.kogine, 'run', 'scripts/data/cache_latents.py', '--config', dataConfig, ...sets(dataKnobs(plan))],
    [plan.kogine, 'run', 'scripts/train/moss.py', '--config', `configs/user/${runName}.py`, ...sets(trainKnobs(plan))],
  ]
}

function posixArg(value: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(value) ? value : posixQuote(value)
}

/**
 * A literal for Windows PowerShell 5.1, which hands a native program its arguments without escaping
 * the double quotes inside them; the C runtime's escaping (a backslash before the quote, and the
 * backslashes in front of it doubled) is done here, so Python reads the value back unchanged.
 */
export function powershellArg(value: string): string {
  let escaped = value.replace(/(\\*)"/g, '$1$1\\"')
  // PowerShell wraps an argument with spaces in quotes; trailing backslashes would escape that quote.
  if (/\s/.test(escaped)) escaped = escaped.replace(/(\\+)$/, '$1$1')
  return `'${escaped.replace(/'/g, "''")}'`
}

/** The script that runs the plan, in its shell's syntax. */
export function trainingScript(plan: TrainingCommandPlan): string {
  const steps = trainingSteps(plan)
  if (plan.shell === 'powershell') {
    const lines = [
      "$ErrorActionPreference = 'Stop'",
      `Set-Location -LiteralPath ${powershellArg(plan.versionDir)}`,
      ...steps.flatMap((step) => [`& ${step.map(powershellArg).join(' ')}`, 'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }']),
      'exit 0',
    ]
    return `${lines.join('\r\n')}\r\n`
  }
  const lines = ['#!/usr/bin/env bash', 'set -euo pipefail', `cd ${posixQuote(plan.versionDir)}`]
  if (plan.shell === 'remote' && plan.pidFile) {
    lines.push(`PID_FILE=${posixQuote(plan.pidFile)}`, 'echo $$ > "$PID_FILE"', 'trap \'rm -f -- "$PID_FILE"\' EXIT')
  }
  lines.push(...steps.map((step) => step.map(posixArg).join(' ')))
  return `${lines.join('\n')}\n`
}
