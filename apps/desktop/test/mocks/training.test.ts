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

    const dataset = await data<TrainingDataset>(backend, Ipc.trainingDatasetAdd, {
      id: draft.id,
      paths: ['/photos/cat-384x288.png', '/photos/folder'],
    })
    expect(dataset.counts).toEqual({ total: 4, small: 1, duplicate: 0, noCaption: 4 })

    const running = await data<TrainingProject>(backend, Ipc.trainingStart, { id: draft.id })
    expect(running.state).toBe('running')
    expect(backend.state.jobs.find((job) => job.id === running.jobId)?.kind).toBe('training')
    expect(await error(backend, Ipc.trainingUpdate, { id: draft.id, patch: { name: 'x' } })).toBe('E_TRAINING_STARTED')
  })

  it('prepares step by step, with the base model download in between', async () => {
    const backend = createMockBackend('trainingNotPrepared')
    backend.state.training.prepareStepMs = 1
    const seen: TrainingReadiness[] = []
    backend.bridge.on(Events.trainingReadinessChanged, (next) => seen.push(next as TrainingReadiness))
    await data(backend, Ipc.trainingPrepare, { hostId: 'local' })
    await settle()
    expect(seen.map((item) => item.prepare.step)).toEqual(['model', 'trainer', 'environment', null])
    expect(seen.at(-1)?.ready).toBe(true)
    expect(backend.state.downloads.every((task) => task.state === 'done')).toBe(true)
  })

  it('saves a chosen step as a LoRA in 模型, or says why it could not', async () => {
    const backend = createMockBackend(scenario('trainings'))
    const chosen = await data<TrainingProject>(backend, Ipc.trainingChooseStep, { id: 'tp-green-mug', step: 1500 })
    expect(chosen).toMatchObject({ chosenStep: 1500, adapterId: 'lora-tp-green-mug', saveError: null })
    expect(backend.state.catalog.adapters.some((adapter) => adapter.id === 'lora-tp-green-mug' && adapter.installed)).toBe(true)

    backend.state.training.saveError = '磁盘满了'
    expect(await data<TrainingProject>(backend, Ipc.trainingChooseStep, { id: 'tp-green-mug', step: 1000 })).toMatchObject({
      adapterId: null,
      saveError: '磁盘满了',
    })
    expect(await error(backend, Ipc.trainingChooseStep, { id: 'tp-green-mug', step: 750 })).toBe('E_NO_CHECKPOINT')
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
