import { describe, expect, it } from 'vitest'
import { Events, Ipc } from '@shared/channels'
import { trainingSchemas, type TrainingDataset, type TrainingProject, type TrainingReadiness } from '@shared/training'
import type { IpcResult } from '@shared/types'
import { createMockBackend, scenario } from './backend'

type Backend = ReturnType<typeof createMockBackend>

async function data<T>(backend: Backend, channel: string, payload?: unknown): Promise<T> {
  const result = await backend.bridge.invoke<IpcResult<T>>(channel, payload)
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

async function error(backend: Backend, channel: string, payload?: unknown): Promise<string> {
  const result = await backend.bridge.invoke<IpcResult<unknown>>(channel, payload)
  return result.ok ? 'ok' : result.error.code
}

const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('mock backend: 训练', () => {
  it('creates a draft, takes pictures, starts and saves a chosen step', async () => {
    const backend = createMockBackend('ready')
    const draft = await data<TrainingProject>(backend, Ipc.trainingCreate, { kind: 'person' })
    expect(trainingSchemas.id.safeParse({ id: draft.id }).success).toBe(true)
    expect(draft.state).toBe('draft')
    expect(await error(backend, Ipc.trainingStart, { id: draft.id })).toBe('E_TRAINING_EMPTY')
    expect((await data<TrainingProject>(backend, Ipc.trainingGet, { id: draft.id })).state).toBe('draft')

    const dataset = await data<TrainingDataset>(backend, Ipc.trainingDatasetAdd, {
      id: draft.id,
      paths: ['/photos/cat-384x288.png', '/photos/folder'],
    })
    expect(dataset.counts).toEqual({ total: 4, small: 1, duplicate: 0, noCaption: 4 })

    backend.state.training.startMs = 5
    const changed: TrainingProject[] = []
    backend.bridge.on(Events.trainingChanged, (next) => changed.push(next as TrainingProject))
    // As main: the start call answers only once the job runs; 'starting' arrives as an event first.
    const started = data<TrainingProject>(backend, Ipc.trainingStart, { id: draft.id })
    await settle(1)
    expect(changed.at(-1)).toMatchObject({ id: draft.id, state: 'starting', jobId: null })
    // Nothing is editable while the pictures are prepared, with main's codes.
    expect(await error(backend, Ipc.trainingUpdate, { id: draft.id, patch: { name: 'x' } })).toBe('E_TRAINING_RUNNING')
    expect(await error(backend, Ipc.trainingDatasetAdd, { id: draft.id, paths: ['/photos/x.png'] })).toBe('E_TRAINING_RUNNING')
    expect(await error(backend, Ipc.trainingStart, { id: draft.id })).toBe('E_TRAINING_RUNNING')
    expect(await error(backend, Ipc.trainingRemove, { id: draft.id })).toBe('E_TRAINING_RUNNING')

    expect((await started).state).toBe('running')
    expect(changed.at(-1)).toMatchObject({ id: draft.id, state: 'running' })
    expect(backend.state.jobs.find((job) => job.id === changed.at(-1)!.jobId)?.kind).toBe('training')
  })

  it('goes back to a draft when the start fails after starting', async () => {
    const backend = createMockBackend(scenario('trainings'))
    backend.state.training.startMs = 1
    backend.state.training.startError = '图片没能传到训练主机。请检查网络后再试。'
    const changed: string[] = []
    backend.bridge.on(Events.trainingChanged, (next) => changed.push((next as TrainingProject).state))
    expect(await error(backend, Ipc.trainingStart, { id: 'tp-aming' })).toBe('E_TRAINING_UPLOAD')
    expect(changed).toEqual(['starting', 'draft'])
  })

  it('prepares step by step, with the base model download in between', async () => {
    const backend = createMockBackend('trainingNotPrepared')
    backend.state.training.prepareStepMs = 1
    const seen: TrainingReadiness[] = []
    backend.bridge.on(Events.trainingReadinessChanged, (next) => seen.push(next as TrainingReadiness))
    await data(backend, Ipc.trainingPrepare, { hostId: 'local' })
    await settle()
    // The environment installs while the base model still downloads, as in main: a second `model` update carries its download.
    expect(seen.map((item) => item.prepare.step)).toEqual(['model', 'model', 'trainer', 'environment', null])
    expect(seen[1]?.prepare.packages).toMatchObject({ stage: 'download', package: 'torch' })
    expect(seen.at(-1)?.ready).toBe(true)
    expect(backend.state.downloads.every((task) => task.state === 'done')).toBe(true)
  })

  it('saves a chosen step as a LoRA in 模型, or says why it could not', async () => {
    const backend = createMockBackend(scenario('trainings'))
    const chosen = await data<TrainingProject>(backend, Ipc.trainingChooseStep, { id: 'tp-green-mug', step: 1500 })
    expect(chosen).toMatchObject({ chosenStep: 1500, adapterId: 'trained-tp-green-mug', saveError: null })
    expect(backend.state.catalog.adapters.some((adapter) => adapter.id === 'trained-tp-green-mug' && adapter.installed)).toBe(true)

    // As main: a failed save keeps the step and LoRA saved before, and names the step that failed.
    backend.state.training.saveError = '磁盘满了'
    expect(await data<TrainingProject>(backend, Ipc.trainingChooseStep, { id: 'tp-green-mug', step: 1000 })).toMatchObject({
      chosenStep: 1500,
      adapterId: 'trained-tp-green-mug',
      saveError: '磁盘满了',
      saveErrorStep: 1000,
    })
    backend.state.training.saveError = null
    expect(await data<TrainingProject>(backend, Ipc.trainingChooseStep, { id: 'tp-green-mug', step: 1000 })).toMatchObject({
      chosenStep: 1000,
      saveError: null,
      saveErrorStep: null,
    })
    expect(await data<TrainingProject>(backend, Ipc.trainingChooseStep, { id: 'tp-green-mug', step: 750 })).toMatchObject({
      chosenStep: 1000,
      saveError: '没有找到第 750 步保存的 LoRA。换一步试试。',
      saveErrorStep: 750,
    })
    expect(await error(backend, Ipc.trainingChooseStep, { id: 'tp-juzi', step: 1000 })).toBe('E_TRAINING_RUNNING')
  })

  it('answers the blocked and the not-prepared scenarios', async () => {
    expect(
      (await data<TrainingReadiness>(createMockBackend('trainingBlocked'), Ipc.trainingReadiness, { hostId: 'local' })).blockReason,
    ).toBe('no-nvidia')
    expect(
      (await data<TrainingReadiness>(createMockBackend('trainingNotPrepared'), Ipc.trainingReadiness, { hostId: 'local' })).ready,
    ).toBe(false)
  })

  it('uses training ids main would accept in every fixture', () => {
    for (const project of scenario('trainings').training.projects) {
      expect(trainingSchemas.id.safeParse({ id: project.id }).success, project.id).toBe(true)
    }
  })
})
