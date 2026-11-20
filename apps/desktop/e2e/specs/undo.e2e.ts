/**
 * Undo and redo on the board: one step per gesture, the toast that names what
 * was undone and offers the way back, the toolbar's 撤销 and 重做, deleting
 * without asking, a job that finishes in between left as it is, an assistant
 * turn as one step with its own 撤销这一步, and a 60-card board where a drag
 * does no history work until it is let go.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import type { JobRecord, ProjectCanvas } from '@shared/types'
import { settle, useApp, type E2eApp, type Theme } from '../support/app'

interface Setup {
  theme?: Theme
  /** Canvases besides 画面 1; the board opens with 画面 1 selected. */
  extra?: Array<Partial<ProjectCanvas> & { id: string }>
  /** Patch for 画面 1. */
  layout?: Partial<ProjectCanvas>
  jobs?: Array<Partial<JobRecord> & { id: string }>
  /** Connect a language model for the 助手, in 自主. */
  assistant?: boolean
}

async function openBoard(app: E2eApp, setup: Setup = {}): Promise<Page> {
  const page = await app.open({ scenario: 'ready', route: '/studio', defer: true, theme: setup.theme })
  await page.evaluate((options) => {
    const { canvasFixture, projectFixture, jobFixture, aiProviderFixture } = window.__mock.fixtures
    const layout = canvasFixture({ id: 'canvas-1', title: '画面 1', prompt: '一只橘猫坐在窗台上', x: 0, y: 0, ...options.layout })
    const extra = (options.extra ?? []).map((patch) => canvasFixture(patch))
    window.__mock.state.projects = [
      projectFixture({ id: 'project-1', name: '小猫', canvases: [layout, ...extra], selectedCanvasId: 'canvas-1' }),
    ]
    window.__mock.state.jobs = (options.jobs ?? []).map((patch) => jobFixture(patch))
    if (options.assistant) {
      window.__mock.state.aiProviders = [aiProviderFixture({ id: 'p1', name: 'DeepSeek', model: 'deepseek-chat' })]
      localStorage.removeItem('mossstudio.agentConversationId')
      localStorage.setItem('mossstudio.agentMode', 'auto')
    }
  }, setup)
  await app.start()
  await page.locator('article[data-canvas-card="canvas-1"]').waitFor()
  await settle(page, 150)
  return page
}

function saved(page: Page, id: string): Promise<ProjectCanvas | undefined> {
  return page.evaluate((cardId) => window.__mock.state.projects[0]?.canvases.find((canvas) => canvas.id === cardId), id)
}

const place = async (page: Page, id: string): Promise<{ x: number; y: number } | null> => {
  const canvas = await saved(page, id)
  return canvas ? { x: canvas.x, y: canvas.y } : null
}

/** Drag a card by its title row; `hold` keeps the button down at the end. */
async function dragCard(
  page: Page,
  id: string,
  by: { x: number; y: number },
  options: { steps?: number; hold?: boolean } = {},
): Promise<void> {
  const header = (await page.locator(`article[data-canvas-card="${id}"] header`).boundingBox())!
  const from = { x: header.x + 40, y: header.y + header.height / 2 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + by.x, from.y + by.y, { steps: options.steps ?? 8 })
  if (!options.hold) await page.mouse.up()
}

function toolbar(page: Page) {
  const bar = page.getByRole('toolbar', { name: '画布工具' })
  return { bar, undo: bar.getByRole('button', { name: '撤销' }), redo: bar.getByRole('button', { name: '重做' }) }
}

const OUTPUT = { path: '/fixture/outputs/run-1-1024x1024.png', width: 1024, height: 1024, seed: 3 }

describe('board undo', () => {
  const app = useApp()

  for (const theme of ['light', 'dark'] as const) {
    it(`a moved card goes back with Ctrl+Z, the toast names it and redoes it, and the toolbar follows (${theme})`, async () => {
      const page = await openBoard(app, { theme })
      const { bar, undo, redo } = toolbar(page)
      // After the hand tool, with the shortcut in the tooltip; nothing to take back yet.
      expect(
        await bar.getByRole('button').evaluateAll((buttons) => buttons.slice(0, 4).map((button) => button.getAttribute('aria-label'))),
      ).toEqual(['选择', '平移', '撤销', '重做'])
      expect([await undo.getAttribute('title'), await redo.getAttribute('title')]).toEqual(['撤销 Ctrl+Z', '重做 Ctrl+Shift+Z'])
      expect([await undo.isDisabled(), await redo.isDisabled()]).toEqual([true, true])

      const start = (await place(page, 'canvas-1'))!
      await dragCard(page, 'canvas-1', { x: 160, y: 80 })
      await expect.poll(async () => (await place(page, 'canvas-1'))!.x, { timeout: 10_000 }).toBeGreaterThan(start.x + 100)
      const moved = (await place(page, 'canvas-1'))!
      await expect.poll(() => undo.isDisabled()).toBe(false)
      expect(await redo.isDisabled()).toBe(true)
      await app.screenshot(`undo-toolbar-${theme}`)

      await page.keyboard.press('Control+z')
      await expect.poll(() => place(page, 'canvas-1'), { timeout: 10_000 }).toEqual(start)
      const toast = page.getByRole('status').filter({ hasText: '已撤销 移动画面 1' })
      await expect.poll(() => toast.isVisible()).toBe(true)
      expect([await undo.isDisabled(), await redo.isDisabled()]).toEqual([true, false])
      await app.screenshot(`undo-toast-${theme}`)

      await toast.getByRole('button', { name: '重做' }).click()
      await expect.poll(() => place(page, 'canvas-1'), { timeout: 10_000 }).toEqual(moved)
      // The same toast place: the new one replaces the old, it does not pile up.
      await expect.poll(() => page.getByRole('status').filter({ hasText: '已重做 移动画面 1' }).isVisible()).toBe(true)
      expect(await page.getByRole('status').filter({ hasText: '已撤销' }).count()).toBe(0)

      // The toolbar and the other shortcuts do the same.
      await undo.click()
      await expect.poll(() => place(page, 'canvas-1'), { timeout: 10_000 }).toEqual(start)
      await page.keyboard.press('Control+y')
      await expect.poll(() => place(page, 'canvas-1'), { timeout: 10_000 }).toEqual(moved)
      await page.keyboard.press('Control+z')
      await page.keyboard.press('Control+Shift+z')
      await expect.poll(() => place(page, 'canvas-1'), { timeout: 10_000 }).toEqual(moved)
    })
  }

  it('Ctrl+Z inside a text field is the field’s own; on the board it takes the whole description back', async () => {
    const page = await openBoard(app)
    const description = page.getByRole('textbox', { name: '描述', exact: true })
    await description.fill('')
    await description.pressSequentially('窗台上的猫')
    await expect.poll(() => toolbar(page).undo.isDisabled()).toBe(false)
    await page.keyboard.press('Control+z')
    await settle(page, 200)
    // The board did not take it: no step undone, so no toast, and the step is still there to undo.
    expect(await page.getByRole('status').filter({ hasText: '已撤销' }).count()).toBe(0)
    expect(await toolbar(page).undo.isDisabled()).toBe(false)
    // From the board, all the typing of that visit is one step.
    await toolbar(page).undo.click()
    await expect.poll(() => description.inputValue()).toBe('一只橘猫坐在窗台上')
    await expect.poll(() => page.getByRole('status').filter({ hasText: '已撤销 改描述 · 画面 1' }).isVisible()).toBe(true)
  })

  it('deletes a 画面 without asking; undo brings it back with its pictures', async () => {
    const page = await openBoard(app, {
      extra: [
        {
          id: 'run-1',
          kind: 'result',
          title: '画面 1',
          sourceCanvasId: 'canvas-1',
          jobId: 'job-1',
          jobState: 'succeeded',
          outputs: [OUTPUT],
        },
      ],
    })
    const card = page.locator('article[data-canvas-card="canvas-1"]')
    await expect.poll(() => card.locator('[data-card-body] img[src*="run-1"]').count()).toBeGreaterThan(0)
    await card.locator('header').click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除画面' }).click()
    await expect.poll(() => card.count()).toBe(0)
    expect(await page.getByRole('dialog').count()).toBe(0)
    await expect.poll(async () => (await saved(page, 'run-1')) ?? null, { timeout: 10_000 }).toBeNull()
    await expect.poll(() => page.getByRole('status').filter({ hasText: '已删除「画面 1」' }).isVisible()).toBe(true)

    await page.keyboard.press('Control+z')
    await expect.poll(() => card.count()).toBe(1)
    await expect.poll(() => card.locator('[data-card-body] img[src*="run-1"]').count()).toBeGreaterThan(0)
    expect(await card.getAttribute('aria-current')).toBe('true')
    await expect.poll(async () => (await saved(page, 'run-1'))?.outputs, { timeout: 10_000 }).toEqual([OUTPUT])
  })

  it('a job that finishes between two edits stays finished when both are undone', async () => {
    const page = await openBoard(app, {
      extra: [
        { id: 'run-1', kind: 'result', title: '画面 1', sourceCanvasId: 'canvas-1', jobId: 'job-1', jobState: 'running', outputs: [] },
      ],
      jobs: [{ id: 'job-1', state: 'running', canvasId: 'run-1' }],
    })
    const card = page.locator('article[data-canvas-card="canvas-1"]')
    const start = (await place(page, 'canvas-1'))!
    await dragCard(page, 'canvas-1', { x: 160, y: 60 })
    await expect.poll(async () => (await place(page, 'canvas-1'))!.x, { timeout: 10_000 }).toBeGreaterThan(start.x + 100)

    // The run finishes: its picture arrives on the card.
    await page.evaluate((output) => {
      const mock = window.__mock
      const job = { ...mock.state.jobs[0]!, state: 'succeeded', outputs: [output] } as JobRecord
      mock.state.jobs = [job]
      mock.emit(mock.Events.job, job)
    }, OUTPUT)
    await expect.poll(() => card.locator('[data-card-body] img[src*="run-1"]').count()).toBeGreaterThan(0)

    const description = page.getByRole('textbox', { name: '描述', exact: true })
    await description.fill('一只橘猫在睡觉')
    const { undo } = toolbar(page)
    await undo.click()
    await expect.poll(() => description.inputValue()).toBe('一只橘猫坐在窗台上')
    await undo.click()
    await expect.poll(() => place(page, 'canvas-1'), { timeout: 10_000 }).toEqual(start)
    // Neither step took the finished run back.
    expect(await card.locator('[data-card-body] img[src*="run-1"]').count()).toBeGreaterThan(0)
    await expect
      .poll(async () => {
        const run = await saved(page, 'run-1')
        return [run?.jobState, run?.outputs?.length]
      })
      .toEqual(['succeeded', 1])
    expect(await undo.isDisabled()).toBe(true)
  })

  for (const theme of ['light', 'dark'] as const) {
    it(`an assistant turn in 自主 is one step, 撤销这一步 under its reply takes it back and 重做 brings it again (${theme})`, async () => {
      const page = await openBoard(app, { theme, assistant: true })
      await page.evaluate(() => {
        window.__mock.state.aiTurn = [
          { name: 'studio_set_prompt', arguments: JSON.stringify({ prompt: '春日花园海报' }) },
          {
            name: 'studio_add_layer',
            arguments: JSON.stringify({ label: 'object', caption: '盛开的樱花枝', bbox: { x: 0.1, y: 0.1, w: 0.6, h: 0.4 } }),
          },
        ]
      })
      await page.getByRole('button', { name: '助手', exact: true }).click()
      const input = page.getByRole('textbox', { name: '给助手的消息' })
      await input.fill('做一张春天的海报')
      await input.press('Enter')

      const card = page.locator('article[data-canvas-card="canvas-1"]')
      const description = page.getByRole('textbox', { name: '描述', exact: true })
      const button = page.locator('[data-turn-undo]')
      await expect.poll(() => button.getAttribute('data-turn-undo'), { timeout: 10_000 }).toBe('latest')
      expect(await button.textContent()).toBe('撤销这一步')
      expect(await description.inputValue()).toBe('春日花园海报')
      expect(await card.locator('[data-region-id]').count()).toBe(1)
      // Two tools, one step.
      await app.screenshot(`undo-assistant-${theme}`)

      await button.click()
      await expect.poll(() => description.inputValue()).toBe('一只橘猫坐在窗台上')
      await expect.poll(() => card.locator('[data-region-id]').count()).toBe(0)
      await expect.poll(() => page.getByRole('status').filter({ hasText: '已撤销 助手的修改' }).isVisible()).toBe(true)
      await expect.poll(() => button.textContent()).toBe('重做')
      expect(await toolbar(page).undo.isDisabled()).toBe(true)

      await button.click()
      await expect.poll(() => description.inputValue()).toBe('春日花园海报')
      await expect.poll(() => card.locator('[data-region-id]').count()).toBe(1)
      await expect.poll(() => button.textContent()).toBe('撤销这一步')

      // A change of the person's own on top: the turn alone cannot be taken back, so the button rests.
      await dragCard(page, 'canvas-1', { x: 140, y: 40 })
      await expect.poll(() => button.getAttribute('data-turn-undo'), { timeout: 10_000 }).toBe('buried')
      expect(await button.isDisabled()).toBe(true)
      expect(await button.getAttribute('title')).toBe('之后画布上又有了改动，要先在画布上撤销它们')
      await toolbar(page).undo.click()
      await expect.poll(() => button.getAttribute('data-turn-undo')).toBe('latest')
      expect(await button.isDisabled()).toBe(false)
    })
  }

  it('on a board of 60 cards a drag does no history work until it is let go, and is one step', async () => {
    const extra = Array.from({ length: 59 }, (_, index) => ({
      id: `card-${index + 2}`,
      title: `画面 ${index + 2}`,
      x: ((index + 1) % 10) * 300,
      y: Math.floor((index + 1) / 10) * 340,
    }))
    const page = await openBoard(app, { extra })
    expect(await page.locator('article[data-canvas-card]').count()).toBe(60)
    const { undo } = toolbar(page)
    const start = (await place(page, 'canvas-1'))!
    const saves = (await app.calls('projects:save')).length
    await dragCard(page, 'canvas-1', { x: 220, y: 120 }, { steps: 30, hold: true })
    await settle(page)
    // Mid-drag: no step yet, nothing written.
    expect(await undo.isDisabled()).toBe(true)
    expect(await place(page, 'canvas-1')).toEqual(start)
    expect((await app.calls('projects:save')).length).toBe(saves)
    await page.mouse.up()
    await expect.poll(async () => (await place(page, 'canvas-1'))!.x, { timeout: 10_000 }).toBeGreaterThan(start.x + 100)
    expect(await undo.isDisabled()).toBe(false)
    await undo.click()
    await expect.poll(() => place(page, 'canvas-1'), { timeout: 10_000 }).toEqual(start)
    // The whole drag was one step.
    expect(await undo.isDisabled()).toBe(true)
  })
})
