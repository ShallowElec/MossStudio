import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSamplePrompts, presetRecipe, trainingSchemas } from '@shared/training'
import { useTempDataRoot } from '@test/helpers/tempDir'
import { pngBytes } from './pictures'

const root = useTempDataRoot()

beforeEach(() => {
  vi.resetModules()
})
const load = () => import('@main/services/training/store')

describe('training store', () => {
  it('creates a draft named by its kind with the standard recipe and a fallback trigger', async () => {
    const { createTrainingProject, getTrainingProject } = await load()
    const person = await createTrainingProject({ kind: 'person', samples: true })
    expect(trainingSchemas.id.safeParse({ id: person.id }).success).toBe(true)
    expect(person).toMatchObject({ name: '新的人物', trigger: 'subj', length: 'standard', hostId: 'local', state: 'draft', imageCount: 0 })
    expect(person.recipe).toEqual(presetRecipe('person', 'standard', { samples: true, trigger: 'subj' }))
    expect(await getTrainingProject(person.id)).toEqual(person)

    const style = await createTrainingProject({ kind: 'style', hostId: 'ssh-gpu', samples: false })
    expect(style).toMatchObject({ name: '新的画风', trigger: '', hostId: 'ssh-gpu' })
    expect(style.recipe.sampleEvery).toBe(0)
  })

  it('lists newest first and counts the pictures', async () => {
    const { createTrainingProject, listTrainingProjects } = await load()
    const first = await createTrainingProject({ kind: 'object', samples: true })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await createTrainingProject({ kind: 'person', samples: true })
    writeFileSync(join(root(), 'training', first.id, 'images', 'a.png'), pngBytes(1024, 1024))
    const list = await listTrainingProjects()
    expect(list.map((item) => item.id)).toEqual([second.id, first.id])
    expect(list[1]!.imageCount).toBe(1)
  })

  it('brings the new preset recipe when 学什么 or 训练多久 changes, keeping the sampling choice', async () => {
    const { createTrainingProject, updateTrainingProject } = await load()
    const project = await createTrainingProject({ kind: 'person', samples: true })
    const withEvery = await updateTrainingProject(project.id, { recipe: { ...project.recipe, sampleEvery: 500 } })
    expect(withEvery.length).toBe('standard')

    const fast = await updateTrainingProject(project.id, { length: 'fast' })
    expect(fast.recipe).toEqual({ ...presetRecipe('person', 'fast', { samples: true, trigger: 'subj' }), sampleEvery: 500 })

    const style = await updateTrainingProject(project.id, { kind: 'style' })
    expect(style.trigger).toBe('')
    expect(style.recipe).toEqual({ ...presetRecipe('style', 'fast', { samples: true, trigger: '' }), sampleEvery: 500 })
  })

  it('keeps a custom recipe when the kind changes, and marks a knob change as 自定义', async () => {
    const { createTrainingProject, updateTrainingProject } = await load()
    const project = await createTrainingProject({ kind: 'object', samples: true })
    const custom = await updateTrainingProject(project.id, { recipe: { ...project.recipe, steps: 1234 } })
    expect(custom.length).toBe('custom')
    const person = await updateTrainingProject(project.id, { kind: 'person' })
    expect(person.length).toBe('custom')
    expect(person.recipe.steps).toBe(1234)
    expect(person.recipe.algo).toBe('lora')
  })

  it('keeps default sample prompts in step with the trigger, but never rewrites prompts the person wrote', async () => {
    const { createTrainingProject, updateTrainingProject } = await load()
    const project = await createTrainingProject({ kind: 'person', samples: true })
    const renamed = await updateTrainingProject(project.id, { trigger: 'mira' })
    expect(renamed.recipe.samplePrompts).toEqual(defaultSamplePrompts('person', 'mira'))

    const own = ['mira 在海边']
    await updateTrainingProject(project.id, { recipe: { ...renamed.recipe, samplePrompts: own } })
    const again = await updateTrainingProject(project.id, { trigger: 'nova' })
    expect(again.recipe.samplePrompts).toEqual(own)
    expect((await updateTrainingProject(project.id, { length: 'fine' })).recipe.samplePrompts).toEqual(own)
  })

  it('takes a patch only while the training is a draft', async () => {
    const { createTrainingProject, mutateTrainingProject, updateTrainingProject } = await load()
    const project = await createTrainingProject({ kind: 'person', samples: true })
    await mutateTrainingProject(project.id, (current) => ({ ...current, state: 'done' }))
    await expect(updateTrainingProject(project.id, { name: 'x' })).rejects.toMatchObject({ code: 'E_TRAINING_NOT_DRAFT' })
  })

  it('writes one change after another, so concurrent changes all land', async () => {
    const { createTrainingProject, mutateTrainingProject, getTrainingProject } = await load()
    const project = await createTrainingProject({ kind: 'person', samples: true })
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        mutateTrainingProject(project.id, async (current) => {
          await new Promise((resolve) => setTimeout(resolve, 5 - index))
          return { ...current, stepReached: current.stepReached + 1 }
        }),
      ),
    )
    expect((await getTrainingProject(project.id)).stepReached).toBe(5)
    expect(existsSync(join(root(), 'training', project.id, 'project.json.tmp'))).toBe(false)
  })

  it('duplicates pictures, descriptions and settings into a new draft named "<name> 2"', async () => {
    const { createTrainingProject, duplicateTrainingProject, mutateTrainingProject, updateTrainingProject } = await load()
    const project = await createTrainingProject({ kind: 'person', samples: true })
    await updateTrainingProject(project.id, { name: '小猫', trigger: 'kitty', length: 'fine' })
    writeFileSync(join(root(), 'training', project.id, 'images', 'a.png'), pngBytes(1024, 1024))
    writeFileSync(join(root(), 'training', project.id, 'images', 'a.txt'), 'kitty')
    await mutateTrainingProject(project.id, (current) => ({
      ...current,
      state: 'done',
      runName: 'kitty-x',
      chosenStep: 500,
      adapterId: 'trained-x',
    }))

    const copy = await duplicateTrainingProject(project.id)

    expect(copy).toMatchObject({
      name: '小猫 2',
      trigger: 'kitty',
      length: 'fine',
      state: 'draft',
      runName: null,
      chosenStep: null,
      adapterId: null,
      imageCount: 1,
    })
    expect(copy.id).not.toBe(project.id)
    expect(readFileSync(join(root(), 'training', copy.id, 'images', 'a.txt'), 'utf8')).toBe('kitty')
  })

  it('removes a training with its folder, but not while it runs', async () => {
    const { createTrainingProject, mutateTrainingProject, removeTrainingProject, listTrainingProjects } = await load()
    const project = await createTrainingProject({ kind: 'person', samples: true })
    await mutateTrainingProject(project.id, (current) => ({ ...current, state: 'running' }))
    await expect(removeTrainingProject(project.id)).rejects.toMatchObject({ code: 'E_TRAINING_RUNNING' })
    await mutateTrainingProject(project.id, (current) => ({ ...current, state: 'stopped' }))
    await removeTrainingProject(project.id)
    expect(existsSync(join(root(), 'training', project.id))).toBe(false)
    expect(await listTrainingProjects()).toEqual([])
  })
})
