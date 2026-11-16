import { describe, expect, it } from 'vitest'
import { presetRecipe, type TrainingRecipe } from '@shared/training'
import {
  overrideLines,
  powershellArg,
  trainingScript,
  trainingSteps,
  trainKnobs,
  type TrainingCommandPlan,
} from '@main/services/training/commands'

const recipe = (patch: Partial<TrainingRecipe> = {}): TrainingRecipe => ({
  ...presetRecipe('object', 'standard', { samples: true, trigger: 'mug' }),
  ...patch,
})

const plan = (patch: Partial<TrainingCommandPlan> = {}): TrainingCommandPlan => ({
  shell: 'posix',
  versionDir: '/data/trainer/versions/kohaku-abc1234',
  configBin: '/data/trainer/runtimes/tr/bin/kohakumoss-config',
  kogine: '/data/trainer/runtimes/tr/bin/kogine',
  weights: '/data/models/training-weights/moss-base-int8',
  data: '/data/training/tp-1/images',
  outputDir: '/data/training/tp-1/runs',
  cacheDir: '/data/training/tp-1/cache',
  configDir: '/data/training/tp-1/configs',
  runName: 'mug-ab12',
  recipe: recipe(),
  ...patch,
})

describe('training commands', () => {
  it('writes the configs, builds both caches, then trains, with the same data knobs for caches and training', () => {
    const steps = trainingSteps(plan())
    expect(steps.map((step) => step.slice(0, 3))).toEqual([
      ['/data/trainer/runtimes/tr/bin/kohakumoss-config', 'new', 'train'],
      ['/data/trainer/runtimes/tr/bin/kogine', 'run', 'scripts/data/cache_text.py'],
      ['/data/trainer/runtimes/tr/bin/kogine', 'run', 'scripts/data/cache_latents.py'],
      ['/data/trainer/runtimes/tr/bin/kogine', 'run', 'scripts/train/moss.py'],
    ])
    const config = steps[0]!
    expect(config).toEqual(
      expect.arrayContaining(['--source', 'folder_nl', '--algo', 'lora', '--name', 'mug-ab12', '--steps', '2000', '--force']),
    )
    expect(config.filter((arg, index) => config[index - 1] === '--prompt')).toEqual(recipe().samplePrompts)
    expect(config).not.toContain('--vram')
    expect(steps[1]).toContain('TARGET_AREA=1048576')
    expect(steps[1]).toContain('CACHE_DIR=/data/training/tp-1/cache')
  })

  it("writes both configs into the training's own folder and runs them by absolute path, whatever checkout the environment points at", () => {
    const steps = trainingSteps(plan())
    const config = steps[0]!
    expect(config[config.indexOf('--out') + 1]).toBe('/data/training/tp-1/configs/mug-ab12.py')
    for (const step of [steps[1]!, steps[2]!])
      expect(step[step.indexOf('--config') + 1]).toBe('/data/training/tp-1/configs/mug-ab12_data.py')
    expect(steps[3]![steps[3]!.indexOf('--config') + 1]).toBe('/data/training/tp-1/configs/mug-ab12.py')
    expect(steps.flat().some((arg) => arg.includes('configs/user'))).toBe(false)
    const windows = trainingSteps(plan({ shell: 'powershell', configDir: 'C:\\data\\training\\tp-1\\configs' }))
    expect(windows[3]).toContain('C:\\data\\training\\tp-1\\configs\\mug-ab12.py')
  })

  it('samples and checkpoints every sampleEvery steps from step 0, and keeps every checkpoint', () => {
    expect(trainKnobs(plan())).toEqual([
      'OUTPUT_DIR=/data/training/tp-1/runs',
      'CACHE_DIR=/data/training/tp-1/cache',
      'TARGET_AREA=1048576',
      'GRAD_ACC=1',
      'DIM=16',
      'ALPHA=16',
      'LR=1e-4',
      'SAVE_EVERY=250',
      'KEEP_LAST=0',
      'CHECKPOINT_EXPORT=true',
      'SAMPLE_EVERY=250',
      'SAMPLE_AT_START=true',
    ])
  })

  it("loads the trainer's code from the version being run, ahead of any PYTHONPATH already set", () => {
    const posix = trainingScript(plan()).split('\n')
    const exportLine = `export PYTHONPATH='/data/trainer/versions/kohaku-abc1234/src'"\${PYTHONPATH:+:$PYTHONPATH}"`
    expect(posix).toContain(exportLine)
    expect(posix.indexOf(exportLine)).toBeLessThan(posix.findIndex((line) => line.includes('kohakumoss-config')))

    const remote = trainingScript(plan({ shell: 'remote', versionDir: '/home/moss/t/versions/remote-ssh-gpu-abc1234', pidFile: '/p' }))
    expect(remote).toContain(`export PYTHONPATH='/home/moss/t/versions/remote-ssh-gpu-abc1234/src'"\${PYTHONPATH:+:$PYTHONPATH}"`)

    const windows = trainingScript(plan({ shell: 'powershell', versionDir: "C:\\Users\\o'neil\\trainer\\versions\\kohaku" })).split('\r\n')
    const assign =
      "$env:PYTHONPATH = 'C:\\Users\\o''neil\\trainer\\versions\\kohaku\\src' + $(if ($env:PYTHONPATH) { ';' + $env:PYTHONPATH } else { '' })"
    expect(windows).toContain(assign)
    expect(windows.indexOf(assign)).toBeLessThan(windows.findIndex((line) => line.startsWith('& ')))
  })

  it('makes 批大小 a real batch on one GPU by accumulating gradients, not the pipeline-only MICROBATCHES', () => {
    const knobs = trainKnobs(plan({ recipe: recipe({ batch: 4 }) }))
    expect(knobs).toContain('GRAD_ACC=4')
    expect(knobs.some((knob) => knob.startsWith('MICROBATCHES='))).toBe(false)
  })

  it('leaves out knobs the recipe leaves to the algorithm, and checkpoints every 500 steps without samples', () => {
    const knobs = trainKnobs(plan({ recipe: recipe({ dim: null, alpha: null, lr: null, sampleEvery: 0, vram: '8' }) }))
    expect(knobs.some((knob) => /^(DIM|ALPHA|LR)=/.test(knob))).toBe(false)
    expect(knobs).toContain('SAVE_EVERY=500')
    expect(knobs).toContain('SAMPLE_EVERY=0')
    expect(knobs).not.toContain('SAMPLE_AT_START=true')
    expect(trainingSteps(plan({ recipe: recipe({ vram: '8' }) }))[0]).toEqual(expect.arrayContaining(['--vram', '8']))
  })

  it("puts the person's overrides last on the train and cache passes, skipping comments and blank lines", () => {
    expect(overrideLines('# note\nLR = 2e-4\n\nnot a knob\nSAMPLE_STEPS=30\r\n')).toEqual(['LR=2e-4', 'SAMPLE_STEPS=30'])
    const steps = trainingSteps(plan({ recipe: recipe({ overrides: 'LR=2e-4\nTARGET_AREA=589824' }) }))
    expect(steps[3]!.slice(-4)).toEqual(['--set', 'LR=2e-4', '--set', 'TARGET_AREA=589824'])
    expect(steps[2]!.slice(-2)).toEqual(['--set', 'TARGET_AREA=589824'])
  })

  it('quotes a POSIX script so spaces, quotes and the trigger in prompts reach the trainer unchanged', () => {
    const script = trainingScript(
      plan({ data: "/home/a b/it's/images", recipe: recipe({ samplePrompts: ['mug，放在木桌上', 'say "hi" $HOME'] }) }),
    )
    expect(script.startsWith("#!/usr/bin/env bash\nset -euo pipefail\ncd '/data/trainer/versions/kohaku-abc1234'\n")).toBe(true)
    expect(script).toContain(`--data '/home/a b/it'\\''s/images'`)
    expect(script).toContain(`--prompt 'mug，放在木桌上'`)
    expect(script).toContain(`--prompt 'say "hi" $HOME'`)
  })

  it('writes a PowerShell script that stops at the first failing step and survives quotes in values', () => {
    const script = trainingScript(
      plan({
        shell: 'powershell',
        versionDir: 'C:\\Users\\张三\\trainer\\versions\\kohaku',
        configBin: 'C:\\Users\\张三\\trainer\\runtimes\\tr\\Scripts\\kohakumoss-config.exe',
        recipe: recipe({ samplePrompts: ['it\'s a "mug"'] }),
      }),
    )
    const lines = script.split('\r\n')
    expect(lines[0]).toBe("Set-Location -LiteralPath 'C:\\Users\\张三\\trainer\\versions\\kohaku'")
    expect(lines[1]).toBe('if (-not $?) { exit 1 }')
    expect(lines[2]).toMatch(/^\$env:PYTHONPATH = /)
    expect(lines[3]).toMatch(/^& 'C:\\Users\\张三\\trainer\\runtimes\\tr\\Scripts\\kohakumoss-config\.exe' 'new' 'train'/)
    expect(lines.filter((line) => line === 'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }')).toHaveLength(4)
    expect(script).toContain(`'--prompt' 'it''s a \\"mug\\"'`)
    expect(script.endsWith('exit 0\r\n')).toBe(true)
  })

  it("does not let PowerShell stop the run on the trainer's log lines to stderr", () => {
    const script = trainingScript(plan({ shell: 'powershell' }))
    expect(script).not.toMatch(/ErrorActionPreference\s*=\s*'Stop'/)
    const lines = script.split('\r\n')
    for (const [index, line] of lines.entries()) {
      if (line.startsWith('& ')) expect(lines[index + 1]).toBe('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }')
    }
  })

  it('escapes PowerShell arguments the way the C runtime reads them back', () => {
    expect(powershellArg('plain')).toBe("'plain'")
    expect(powershellArg("it's")).toBe("'it''s'")
    expect(powershellArg('a\\"b')).toBe(`'a\\\\\\"b'`)
    expect(powershellArg('C:\\with space\\')).toBe("'C:\\with space\\\\'")
  })

  it('records its pid on a remote host so 停止 can end it', () => {
    const script = trainingScript(plan({ shell: 'remote', pidFile: '/home/moss/.mossstudio/trainer/training/tp-1/run.pid' }))
    expect(script).toContain('PID_FILE=\'/home/moss/.mossstudio/trainer/training/tp-1/run.pid\'\necho $$ > "$PID_FILE"')
    expect(script).toContain('trap \'rm -f -- "$PID_FILE"\' EXIT')
    expect(script.indexOf('PID_FILE=')).toBeLessThan(script.indexOf('kohakumoss-config'))
  })
})
