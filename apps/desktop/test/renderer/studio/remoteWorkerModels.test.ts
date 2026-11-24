import { describe, expect, it } from 'vitest'
import type { RemoteWorkerModelInventory } from '@shared/remoteWorker'
import type { ModelBundle, ModelEntry } from '@shared/types'
import { catalogFixture, SFT_BUNDLE_IDS } from '@test/mocks/backend'
import { bundleBlocker } from '../../../src/renderer/src/pages/models/logic'
import { applyLoraAutoTriggers } from '../../../src/renderer/src/pages/studio/prompt'
import {
  canvasModelForWorkerPick,
  missingWorkerAdapters,
  parseWorkerModelPicks,
  resolveWorkerBundle,
  workerAdapterEntries,
  workerModelOrder,
} from '../../../src/renderer/src/pages/studio/remoteWorkerLoras'

const SFT_INT8_IDS = ['moss-sft-comfy-int8_convrot', 'qwen35-comfy-int8_convrot', 'flux2-vae-comfy-small', 'moss-runtime-config']

const HOST = { id: 'ssh-gpu-1', name: 'GPU Worker', workerProviderId: 'worker-gpu-1' }

const WORKER_INVENTORY: RemoteWorkerModelInventory = {
  root: '/srv/worker/models',
  defaultModelId: 'moss-sft',
  models: [
    {
      id: 'moss-sft',
      name: 'MOSS-Image SFT',
      variant: ['BF16'],
      tier: 'reference',
      profile: 'standard',
      catalogBundleId: 'moss-sft',
      sizeBytes: 27_000_000_000,
    },
    {
      id: 'sft-int8',
      name: 'MOSS-Image SFT INT8',
      variant: ['INT8'],
      tier: 'high',
      profile: 'standard',
      catalogBundleId: 'moss-sft-int8',
      defaults: { steps: 16, cfg: 3 },
      sizeBytes: 9_600_000_000,
    },
    { id: 'my-finetune', name: 'My finetune' },
  ],
  components: [],
}

describe('Worker real model resolution and strength=0 LoRAs', () => {
  it('ignores strength=0 LoRAs in missingWorkerAdapters', () => {
    const entries = workerAdapterEntries([
      { id: 'registered.safetensors', name: 'registered.safetensors', sizeBytes: 10, registered: true },
    ])
    const missing = missingWorkerAdapters(
      [
        { id: 'registered.safetensors', strength: 0.9 },
        { id: 'unregistered_zero.safetensors', strength: 0 },
        { id: 'unregistered_active.safetensors', strength: 0.5 },
      ],
      entries,
    )
    expect(missing.map((m) => m.id)).toEqual(['unregistered_active.safetensors'])
  })

  it('skips auto-inserting trigger words for strength=0 LoRAs', () => {
    const prompt = applyLoraAutoTriggers(
      'a portrait',
      [
        { id: 'disabled.safetensors', strength: 0 },
        { id: 'active.safetensors', strength: 0.8 },
      ],
      {
        'disabled.safetensors': { triggers: ['@disabled_style'], autoInsert: 'prefix' },
        'active.safetensors': { triggers: ['@active_style'], autoInsert: 'prefix' },
      },
    )
    expect(prompt).toBe('@active_style, a portrait')
  })

  it('resolves real models from worker inventory and falls back cleanly for legacy daemons', () => {
    const legacyPlaceholder = resolveWorkerBundle(HOST, WORKER_INVENTORY, ['remote-worker:worker-gpu-1'], null)
    expect(legacyPlaceholder.bundle?.id).toBe('moss-sft')

    const explicit = resolveWorkerBundle(HOST, WORKER_INVENTORY, ['sft-int8'], null)
    expect(explicit.bundle?.id).toBe('sft-int8')
    expect(explicit.bundle?.tier).toBe('high')
    expect(explicit.bundle?.defaults).toEqual({ steps: 16, cfg: 3 })
    // A 画面's catalog model finds the Worker model that is it, under the Worker's own id.
    expect(resolveWorkerBundle(HOST, WORKER_INVENTORY, [null, 'moss-sft-int8'], null).bundle?.id).toBe('sft-int8')
    // The Worker pick comes first; an id the Worker lacks is skipped.
    expect(resolveWorkerBundle(HOST, WORKER_INVENTORY, ['my-finetune', 'moss-sft-int8'], null).bundle?.id).toBe('my-finetune')
    expect(resolveWorkerBundle(HOST, WORKER_INVENTORY, ['gone', 'moss-sft-int8'], null).bundle?.id).toBe('sft-int8')

    const unsupported = resolveWorkerBundle(HOST, { models: [], components: [], unsupported: true }, [], null)
    expect(unsupported.bundle?.id).toBe('remote-worker:worker-gpu-1')
    expect(unsupported.installed).toBe(true)
  })

  it('prefers the 画面’s own model over a Worker pick made over another model', () => {
    const pick = { id: 'my-finetune', over: 'moss-sft' }
    const run = (canvasModel: string | undefined): string | undefined =>
      resolveWorkerBundle(HOST, WORKER_INVENTORY, workerModelOrder(pick, canvasModel, null), null).bundle?.id
    // The 画面 the pick was made on runs the pick.
    expect(run('moss-sft')).toBe('my-finetune')
    // Another 画面 whose model the Worker also has keeps it.
    expect(run('moss-sft-int8')).toBe('sft-int8')
    // A 画面 whose model the Worker lacks falls back to the pick.
    expect(run('moss-elsewhere')).toBe('my-finetune')
    expect(run(undefined)).toBe('my-finetune')
  })

  it('reads the Worker picks per host and drops malformed ones', () => {
    expect(parseWorkerModelPicks(null)).toEqual(new Map())
    expect(parseWorkerModelPicks('my-finetune')).toEqual(new Map())
    expect(parseWorkerModelPicks('["a"]')).toEqual(new Map())
    expect(
      parseWorkerModelPicks(JSON.stringify({ a: { id: 'sft-int8', over: 'moss-sft' }, b: { id: 'my-finetune' }, c: { id: 3 }, d: null })),
    ).toEqual(
      new Map([
        ['a', { id: 'sft-int8', over: 'moss-sft' }],
        ['b', { id: 'my-finetune' }],
      ]),
    )
  })

  it('keeps a host id like __proto__ as a plain key, never on a prototype', () => {
    const picks = parseWorkerModelPicks('{"__proto__": {"id": "sft-int8"}, "constructor": {"id": "my-finetune"}}')
    expect(picks.get('__proto__')).toEqual({ id: 'sft-int8' })
    expect(picks.get('constructor')).toEqual({ id: 'my-finetune' })
    expect(picks.get('toString')).toBeUndefined()
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)['id']).toBeUndefined()
  })

  it('keeps a downloaded catalog model in the 画面 when a Worker model is picked, never the Worker’s own id', () => {
    const catalog = catalogFixture({ installed: [...SFT_BUNDLE_IDS, ...SFT_INT8_IDS] })
    const [, int8, finetune] = WORKER_INVENTORY.models
    expect(canvasModelForWorkerPick(int8, catalog, 'moss-sft')).toBe('moss-sft-int8')
    expect(canvasModelForWorkerPick(finetune, catalog, 'moss-sft')).toBe('moss-sft')
    expect(canvasModelForWorkerPick(finetune, catalog, undefined)).toBeUndefined()
    // A catalog id this computer's library does not have is not kept either.
    expect(canvasModelForWorkerPick({ catalogBundleId: 'moss-elsewhere' }, catalog, 'moss-sft')).toBe('moss-sft')
  })

  it('keeps the 画面’s model when the picked Worker model is not downloaded here', () => {
    // moss-sft is installed, SFT INT8 only on the Worker: back here the 画面 must still run moss-sft.
    const catalog = catalogFixture({ installed: SFT_BUNDLE_IDS })
    expect(canvasModelForWorkerPick(WORKER_INVENTORY.models[1], catalog, 'moss-sft')).toBe('moss-sft')
  })

  it('allows single-file catalog bundles on worker-daemon hosts while still blocking them on plain SSH hosts', () => {
    const int8Bundle: ModelBundle = {
      id: 'moss-sft-int8',
      name: 'MOSS-Image SFT INT8',
      description: 'INT8',
      tier: 'high',
      certified: true,
      components: { dit: 'moss-sft-comfy-int8_convrot', textEncoder: 'qwen35-comfy-int8_convrot', vae: 'flux2-vae-comfy-small' },
      support: 'moss-runtime-config',
    }
    const models: ModelEntry[] = [
      {
        id: 'moss-sft-comfy-int8_convrot',
        name: 'SFT INT8',
        provider: 'hf',
        repo: 'OpenMOSS-Team/MOSS-Image-SFT',
        revision: 'main',
        role: 'dit',
        precision: 'int8',
        format: 'comfyui',
        sizeBytes: 9_600_000_000,
        license: 'apache-2.0',
        tags: [],
        installed: false,
        installedBytes: 0,
      },
    ]
    expect(bundleBlocker(int8Bundle, models, { remote: true, workerDaemon: true, gpus: [] })).toBeNull()
    expect(bundleBlocker(int8Bundle, models, { remote: true, workerDaemon: false, gpus: [] })).toContain('只能在这台电脑上使用')
  })
})
