import { describe, expect, it } from 'vitest'
import { baseModelTasks, checkRows, homeCard, homeView, projectView, splitHome } from '@renderer/pages/training/trainingModel'
import { catalogFixture, downloadFixture } from '../../mocks/backend/fixtures'
import {
  trainingBlockedFixture,
  trainingNotPreparedFixture,
  trainingProjectFixture,
  trainingReadinessFixture,
} from '../../mocks/backend/training'

const ready = trainingReadinessFixture()
const draft = trainingProjectFixture()

describe('homeView: what /training shows', () => {
  it('waits until both the readiness and the list are read', () => {
    expect(homeView(undefined, [])).toBe('loading')
    expect(homeView(ready, undefined)).toBe('loading')
  })

  it('shows the blocked screen on a computer that cannot train, even with trainings', () => {
    expect(homeView(trainingBlockedFixture(), [])).toBe('blocked')
    expect(homeView(trainingBlockedFixture(), [draft])).toBe('blocked')
  })

  it('shows first use while nothing is prepared and there are no trainings', () => {
    expect(homeView(trainingNotPreparedFixture(), [])).toBe('oobe')
    const preparing = { ...trainingNotPreparedFixture(), prepare: { running: true, step: 'model' as const, error: null } }
    expect(homeView(preparing, [])).toBe('oobe')
  })

  it('asks what to teach once ready, or after 先选图片 while preparing', () => {
    expect(homeView(ready, [])).toBe('start')
    const preparing = { ...trainingNotPreparedFixture(), prepare: { running: true, step: 'model' as const, error: null } }
    expect(homeView(preparing, [], { picking: true })).toBe('start')
  })

  it('lists the trainings once there are any, and asks again for 新建训练', () => {
    expect(homeView(ready, [draft])).toBe('home')
    expect(homeView(trainingNotPreparedFixture(), [draft])).toBe('home')
    expect(homeView(ready, [draft], { picking: true })).toBe('start')
  })

  it('says it could not read the readiness only when there is nothing else to show', () => {
    expect(homeView(null, [])).toBe('error')
    expect(homeView(null, [draft])).toBe('home')
  })
})

describe('projectView', () => {
  it('edits a draft, follows a running training, and shows the result otherwise', () => {
    expect(projectView('draft')).toBe('editor')
    expect(projectView('running')).toBe('running')
    expect(projectView('done')).toBe('result')
    expect(projectView('stopped')).toBe('result')
    expect(projectView('failed')).toBe('result')
  })
})

describe('checkRows: the first-use check', () => {
  it('says what this computer has and what is still to get', () => {
    const rows = checkRows(trainingNotPreparedFixture())
    expect(rows.map((row) => [row.title, row.pill.text])).toEqual([
      ['显卡', '可以训练'],
      ['内存', '够用'],
      ['底模', '需要下载 · 9.5 GB'],
      ['训练环境', '需要下载'],
      ['空间', '够用'],
    ])
    expect(rows[0]!.value).toBe('NVIDIA GeForce RTX 4070 · 12 GB')
    expect(rows.every((row) => row.progress === undefined)).toBe(true)
  })

  it('shows the base model download with its real progress while preparing', () => {
    const readiness = { ...trainingNotPreparedFixture(), prepare: { running: true, step: 'model' as const, error: null } }
    const bundle = catalogFixture().bundles.find((item) => item.id === 'moss-base')
    const downloads = [
      downloadFixture({
        targetId: 'moss-base-dit',
        state: 'running',
        bytes: 4 * 1024 ** 3,
        totalBytes: 8 * 1024 ** 3,
        speedBps: 40 * 1024 ** 2,
      }),
      downloadFixture({ id: 'model:other', targetId: 'moss-sft-dit', state: 'running', bytes: 1, totalBytes: 2 }),
    ]
    const tasks = baseModelTasks(bundle, downloads)
    expect(tasks.map((task) => task.targetId)).toEqual(['moss-base-dit'])
    const model = checkRows(readiness, tasks).find((row) => row.id === 'model')!
    expect(model.pill).toEqual({ tone: 'accent', text: '下载中 50%' })
    expect(model.progress).toBe(50)
    expect(model.detail).toBe('4.0 GB / 8.0 GB · 40 MB/s')
    const trainer = checkRows(readiness, tasks).find((row) => row.id === 'trainer')!
    expect(trainer.progress).toBeNull()
  })

  it('moves the trainer row on as preparing does', () => {
    const readiness = {
      ...trainingNotPreparedFixture(),
      baseModel: { ...trainingNotPreparedFixture().baseModel, installed: true, missingBytes: 0 },
      prepare: { running: true, step: 'environment' as const, error: null },
    }
    const rows = checkRows(readiness)
    expect(rows.find((row) => row.id === 'model')!.pill.text).toBe('已下载')
    const trainer = rows.find((row) => row.id === 'trainer')!
    expect(trainer.value).toBe('Kohaku Trainer · 正在安装训练环境')
    expect(trainer.pill).toEqual({ tone: 'accent', text: '安装中' })
  })

  it('marks a card that cannot train', () => {
    expect(checkRows(trainingBlockedFixture())[0]!.pill).toEqual({ tone: 'danger', text: '不能训练' })
  })
})

describe('home cards', () => {
  const relative = (value: string): string => `rel:${value}`

  it('puts running trainings first and the rest newest first', () => {
    const list = [
      trainingProjectFixture({ id: 'tp-aaaa', updatedAt: '2026-11-01T00:00:00Z', state: 'done' }),
      trainingProjectFixture({ id: 'tp-bbbb', updatedAt: '2026-11-03T00:00:00Z', state: 'failed' }),
      trainingProjectFixture({ id: 'tp-cccc', updatedAt: '2026-10-01T00:00:00Z', state: 'running' }),
    ]
    const { running, rest } = splitHome(list)
    expect(running.map((item) => item.id)).toEqual(['tp-cccc'])
    expect(rest.map((item) => item.id)).toEqual(['tp-bbbb', 'tp-aaaa'])
  })

  it('shows the kind for a finished training and a state for the others', () => {
    expect(homeCard(trainingProjectFixture({ state: 'done', finishedAt: 'T' }), relative)).toMatchObject({
      pill: null,
      kind: '人物',
      caption: 'rel:T',
    })
    expect(homeCard(trainingProjectFixture({ state: 'failed', failure: '显存不够' }), relative)).toMatchObject({
      pill: { tone: 'danger', text: '失败' },
      caption: '显存不够',
    })
    expect(homeCard(trainingProjectFixture({ state: 'stopped', stepReached: 1500 }), relative)).toMatchObject({
      pill: { tone: 'neutral', text: '已停止' },
      caption: '停在第 1,500 步',
    })
    expect(homeCard(trainingProjectFixture({ state: 'done', saveError: '磁盘满了' }), relative).pill).toEqual({
      tone: 'warn',
      text: '没有保存',
    })
  })
})
