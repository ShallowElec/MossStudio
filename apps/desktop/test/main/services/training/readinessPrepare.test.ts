import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Events } from '@shared/channels'
import type { TrainingReadiness } from '@shared/training'
import type { GpuInventoryDevice, TrainerVersion } from '@shared/types'
import { usePlatform } from '@test/helpers/platform'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { settingsFixture } from '@test/mocks/backend/fixtures'

const GIB = 1024 ** 3
const state = {
  devices: [] as GpuInventoryDevice[],
  installed: new Set<string>(),
  versions: [] as TrainerVersion[],
  downloadState: 'done' as string,
  downloadGate: Promise.resolve() as Promise<void>,
  installFails: false,
  freeBytes: 0,
}
const emitted: TrainingReadiness[] = []
const installTrainerRuntime = vi.fn(async () => {
  if (state.installFails) throw new Error('pip: resolution failed for torch')
  state.versions = [{ id: 'kohaku-abc1234', status: 'ok', runtimeState: 'ready' } as TrainerVersion]
})
const createTrainerVersion = vi.fn(async () => ({ id: 'kohaku-abc1234' }))

const catalog = () => ({
  bundles: [
    { id: 'moss-base-int8', name: 'MOSS-Image Base INT8', components: { dit: 'd8', textEncoder: 't8', vae: 'v8' }, support: 's8' },
    { id: 'moss-base', name: 'MOSS-Image Base', components: { dit: 'd', textEncoder: 't', vae: 'v' }, support: 's' },
  ],
  models: ['d8', 't8', 'v8', 's8', 'd', 't', 'v', 's'].map((id) => ({ id, installed: state.installed.has(id), sizeBytes: GIB })),
})

vi.mock('@main/lib/events', () => ({
  emit: (channel: string, payload: TrainingReadiness) => channel === Events.trainingReadinessChanged && emitted.push(payload),
}))
vi.mock('@main/services/settings', () => ({ getSettings: () => settingsFixture() }))
vi.mock('@main/services/devices', () => ({ getGpuInventory: async () => ({ scannedAt: '', status: 'ok', devices: state.devices }) }))
vi.mock('@main/services/models', () => ({
  getCatalog: async () => catalog(),
  modelMissingBytes: async (_settings: unknown, model: { sizeBytes: number }) => model.sizeBytes,
  installBundle: async () => [{ id: 'model:d8' }],
  waitForDownload: async () => {
    await state.downloadGate
    if (state.downloadState === 'done') for (const id of ['d8', 't8', 'v8', 's8']) state.installed.add(id)
    return { id: 'model:d8', state: state.downloadState }
  },
}))
vi.mock('@main/lib/disk', () => ({ freeSpace: async () => state.freeBytes }))
vi.mock('@main/services/trainers', () => ({
  listTrainerVersions: async () => state.versions,
  createTrainerVersion: () => createTrainerVersion(),
  installTrainerRuntime: () => installTrainerRuntime(),
}))
vi.mock('@main/services/trainerGit', () => ({
  listTrainerBranches: async () => [{ name: 'main', sha: 'f'.repeat(40), isDefault: true, isStable: false }],
  trainerTagSha: async () => 'a'.repeat(40),
}))

useTempDataRoot()
usePlatform('linux')

beforeEach(() => {
  vi.resetModules()
  state.devices = [
    { uuid: 'a', index: 0, name: 'NVIDIA GeForce RTX 3060', memoryTotalBytes: 12 * GIB },
    { uuid: 'b', index: 1, name: 'NVIDIA GeForce RTX 4090', memoryTotalBytes: 24 * GIB },
    { uuid: 'c', index: 2, name: 'AMD Radeon', memoryTotalBytes: 48 * GIB, vendor: 'amd' },
  ]
  state.installed = new Set()
  state.versions = []
  state.downloadState = 'done'
  state.installFails = false
  state.downloadGate = Promise.resolve()
  state.freeBytes = 500 * GIB
  emitted.length = 0
  createTrainerVersion.mockClear()
  installTrainerRuntime.mockClear()
})
const load = () => import('@main/services/training/readiness')

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('local training readiness', () => {
  it('uses the largest NVIDIA card and names what is missing', async () => {
    const { trainingReadiness, localTrainingGpu } = await load()
    expect((await localTrainingGpu())?.index).toBe(1)
    const readiness = await trainingReadiness('local')
    expect(readiness).toMatchObject({
      hostId: 'local',
      gpu: { name: 'NVIDIA GeForce RTX 4090', memoryBytes: 24 * GIB, ok: true },
      baseModel: { bundleId: 'moss-base-int8', installed: false, missingBytes: 4 * GIB },
      trainer: { versionId: null, state: 'missing' },
      blockReason: null,
      ready: false,
      samplesByDefault: true,
    })
  })

  it('counts the bf16 base as installed when the INT8 one is not', async () => {
    const { trainingReadiness } = await load()
    for (const id of ['d', 't', 'v', 's']) state.installed.add(id)
    expect((await trainingReadiness('local')).baseModel).toEqual({
      bundleId: 'moss-base',
      name: 'MOSS-Image Base',
      installed: true,
      missingBytes: 0,
    })
  })

  it('is not ready without room for the base model, the environment and a run', async () => {
    const { trainingReadiness } = await load()
    state.freeBytes = 20 * GIB
    expect((await trainingReadiness('local')).disk).toMatchObject({ freeBytes: 20 * GIB, ok: false })
    state.freeBytes = 25 * GIB
    expect((await trainingReadiness('local')).disk.ok).toBe(true)
  })

  it('blocks a computer without an NVIDIA card', async () => {
    state.devices = state.devices.filter((device) => device.vendor === 'amd')
    const { trainingReadiness } = await load()
    expect((await trainingReadiness('local')).blockReason).toBe('no-nvidia')
  })

  it('prepares the model and the stable trainer once, however often it is asked, and ends ready', async () => {
    let open = (): void => undefined
    state.downloadGate = new Promise<void>((resolve) => (open = resolve))
    const { prepareTraining, trainingReadiness } = await load()
    const first = await prepareTraining('local')
    const second = await prepareTraining('local')
    expect(first.prepare.running).toBe(true)
    expect(second.ready).toBe(false)
    await settle()
    expect(emitted.at(-1)?.prepare.step).toBe('model')
    open()
    await settle()
    expect(createTrainerVersion).toHaveBeenCalledOnce()
    expect(installTrainerRuntime).toHaveBeenCalledOnce()
    const readiness = await trainingReadiness('local')
    expect(readiness).toMatchObject({ ready: true, prepare: { running: false, step: null, error: null } })
    expect(emitted.at(-1)?.ready).toBe(true)
  })

  it('shows the trainer and environment steps when the model is already there', async () => {
    for (const id of ['d8', 't8', 'v8', 's8']) state.installed.add(id)
    const { prepareTraining } = await load()
    await prepareTraining('local')
    await settle()
    // Each event carries the readiness when it is sent, so a quick step may already have passed.
    expect(emitted.map((item) => item.prepare.step)).toContain('environment')
    expect(emitted.some((item) => item.prepare.step === 'model')).toBe(false)
    expect(emitted.at(-1)).toMatchObject({ ready: true, prepare: { running: false, step: null } })
  })

  it('keeps a failed step in plain words, without the installer output', async () => {
    state.installFails = true
    const { prepareTraining, trainingReadiness } = await load()
    await prepareTraining('local')
    await settle()
    const readiness = await trainingReadiness('local')
    expect(readiness.prepare.error).toBe('训练环境没有装好。检查网络后再点一次准备。')
    expect(readiness.trainer.state).toBe('error')
    expect(readiness.ready).toBe(false)
  })
})
