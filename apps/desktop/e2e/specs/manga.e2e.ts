/**
 * 漫画: a series from nothing to an exported chapter. The language model's
 * storyboard and memory, the drawing queue with its retry, review (通过,
 * 重画 with a note), export, and character reference pictures.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { PAGE_HEIGHT } from '@shared/manga/layouts'
import { useApp } from '../support/app'

const JOBS = 'http:POST /api/engine-jobs'

const STORYBOARD = JSON.stringify({
  pages: [
    {
      layout: 'two-rows',
      panels: [
        {
          scene: '旧港口，雾很浓',
          shot: 'wide',
          cast: [{ name: '阿秋', expression: '警惕' }],
          dialogue: [{ kind: 'narration', text: '午夜，旧港口。' }],
        },
        { scene: '阿秋回头', shot: 'close', cast: [{ name: '阿秋' }], dialogue: [{ speaker: '阿秋', kind: 'speech', text: '谁在那里？' }] },
      ],
    },
  ],
})

const MEMORY = JSON.stringify({ summary: '阿秋在旧港口察觉有人跟踪。', facts: ['旧港口有人跟踪阿秋'] })

describe('manga', () => {
  const app = useApp()

  const panels = (page: Page) => page.locator('[data-manga-panel]')
  const panel = (page: Page, id: string) => page.locator(`[data-manga-panel="${id}"]`)

  async function openSeries(seed: () => void): Promise<Page> {
    const page = await app.open({ scenario: 'ready', route: '/manga', theme: 'light', defer: true })
    await page.evaluate(seed)
    await app.start()
    return page
  }

  it('creates a series, writes a character and storyboards a chapter with the language model', async () => {
    const page = await openSeries(() => {
      localStorage.removeItem('mossstudio.manga.open')
      const mock = window.__mock
      mock.state.aiProviders = [
        {
          id: 'p1',
          name: 'DeepSeek',
          kind: 'openai',
          baseUrl: 'https://api.example',
          model: 'deepseek-chat',
          temperature: 0.7,
          hasKey: true,
        },
      ]
    })
    await page.evaluate(
      (answers) => {
        window.__mock.state.aiCompletions = answers
      },
      [STORYBOARD, MEMORY],
    )
    await page.getByRole('heading', { name: '漫画' }).waitFor()
    await page.getByRole('button', { name: '新建漫画' }).click()
    await page.getByRole('heading', { name: '未命名漫画' }).waitFor()
    // A new series gets its own project for pictures.
    await expect.poll(() => page.evaluate(() => window.__mock.state.projects.map((project) => project.name))).toContain('漫画 · 未命名漫画')

    await page.getByRole('tab', { name: /人物/ }).click()
    await page.getByRole('button', { name: '添加人物' }).click()
    await page.getByLabel('名字').fill('阿秋')
    await page.getByLabel('外貌').fill('短黑发，琥珀色眼睛')

    await page.getByRole('tab', { name: /章节/ }).click()
    await page.getByLabel('大纲', { exact: true }).fill('阿秋深夜去旧港口调查，察觉有人跟踪。')
    await page.getByRole('button', { name: '生成分镜' }).click()
    await expect.poll(() => panels(page).count()).toBe(2)

    const [request] = await app.calls<{ system: string; prompt: string }>('ai:complete')
    expect(request!.system).toContain('只输出一个 JSON 对象')
    expect(request!.prompt).toContain('- 阿秋')
    expect(request!.prompt).toContain('阿秋深夜去旧港口调查')
    expect(await panels(page).first().getByLabel('画面描述').inputValue()).toBe('旧港口，雾很浓')
    expect(await panels(page).nth(1).getByLabel('台词').inputValue()).toBe('谁在那里？')
    expect(await page.getByRole('img', { name: '第 1 页预览' }).isVisible()).toBe(true)

    // The storyboard is saved with the character mapped by name.
    await expect
      .poll(() =>
        app
          .calls<{
            characters: Array<{ id: string; name: string }>
            chapters: Array<{ pages: Array<{ panels: Array<{ cast: Array<{ characterId: string }> }> }> }>
          }>('manga:save')
          .then((calls) => {
            const last = calls.at(-1)
            const aki = last?.characters.find((item) => item.name === '阿秋')
            return Boolean(aki && last?.chapters[0]?.pages[0]?.panels[0]?.cast[0]?.characterId === aki.id)
          }),
      )
      .toBe(true)

    // 写入剧情记忆: the summary and the new fact show under 剧情记忆.
    await page.getByRole('button', { name: '写入剧情记忆' }).click()
    await page.getByText('已记下这一话，新增 1 条设定').waitFor()
    await page.getByRole('tab', { name: '剧情记忆' }).click()
    expect(await page.getByRole('textbox', { name: '设定 1' }).inputValue()).toBe('旧港口有人跟踪阿秋')
    expect(await page.getByLabel('第 1 话').inputValue()).toBe('阿秋在旧港口察觉有人跟踪。')
  })

  it('draws a chapter two panels at a time, retries a failure, and exports after review', async () => {
    const page = await openSeries(() => {
      const { mangaSeriesFixture } = window.__mock.fixtures
      const lora = (id: string, name: string) => ({
        id,
        name,
        provider: 'local' as const,
        repo: '',
        revision: '',
        kind: 'lora' as const,
        license: '',
        files: [],
        sizeBytes: 1,
        tags: [],
        installed: true,
        installedBytes: 1,
      })
      window.__mock.state.catalog = { ...window.__mock.state.catalog, adapters: [lora('ink-style', '墨线'), lora('aki-lora', '阿秋')] }
      window.__mock.state.manga = [mangaSeriesFixture()]
      localStorage.setItem('mossstudio.manga.open', 'manga-1')
    })
    await page.getByRole('heading', { name: '雨夜侦探' }).waitFor()
    // The page's clock keeps running; the retry wait below jumps it forward instead of sleeping.
    await page.clock.install()
    // Not every panel is approved yet: nothing to export.
    expect(await page.getByRole('button', { name: '导出这一话' }).isDisabled()).toBe(true)

    await page.getByRole('button', { name: '生成全部' }).click()
    await expect.poll(() => app.calls(JOBS).then((calls) => calls.length)).toBe(2)
    const [first] = await app.calls<Record<string, unknown>>(JOBS)
    expect(first).toMatchObject({
      projectId: 'project-manga',
      canvasId: 'panel-1',
      adapters: [
        { id: 'ink-style', strength: 1 },
        { id: 'aki-lora', strength: 0.8 },
      ],
      visionReferences: { paths: ['/fixture/projects/project-manga/assets/aki.png'] },
    })
    expect(String(first!['prompt'])).toContain('阿秋：akiOC，短黑发')
    await expect.poll(() => panel(page, 'panel-3').getAttribute('data-state')).toBe('queued')

    await page.evaluate(() => window.__mock.finishJob('job-e2e-1'))
    await expect.poll(() => panel(page, 'panel-1').getAttribute('data-state')).toBe('review')
    // A slot came free: the third panel goes.
    await expect.poll(() => app.calls(JOBS).then((calls) => calls.length)).toBe(3)

    // A failed run goes back in the queue, waits so the graphics memory can free up, and is drawn again.
    await page.evaluate(() => window.__mock.finishJob('job-e2e-2', { fail: { code: 'E_OOM', message: '显存不够' } }))
    await panel(page, 'panel-2')
      .getByText(/上次没成功，\d+ 秒后重试：显存不够/)
      .waitFor()
    expect(await panel(page, 'panel-2').getAttribute('data-state')).toBe('queued')
    expect(await app.calls(JOBS).then((calls) => calls.length)).toBe(3)
    await page.clock.fastForward(16_000)
    await expect.poll(() => app.calls(JOBS).then((calls) => calls.length)).toBe(4)
    await panel(page, 'panel-2').getByText('上次没成功，正在重试：显存不够').waitFor()
    expect((await app.calls<{ canvasId: string }>(JOBS)).at(-1)!.canvasId).toBe('panel-2')

    await page.evaluate(() => {
      window.__mock.finishJob('job-e2e-3')
      window.__mock.finishJob('job-e2e-4')
    })
    await expect.poll(() => page.locator('[data-manga-panel][data-state="review"]').count()).toBe(3)

    // 重画 with a note: the next run is told what to change.
    await panel(page, 'panel-3')
      .getByLabel(/要改什么/)
      .fill('眼神更凶一点')
    await panel(page, 'panel-3').getByRole('button', { name: '重画' }).click()
    await expect.poll(() => app.calls(JOBS).then((calls) => calls.length)).toBe(5)
    expect(String((await app.calls<{ prompt: string }>(JOBS)).at(-1)!.prompt)).toContain('修改要求：眼神更凶一点')
    await page.evaluate(() => window.__mock.finishJob('job-e2e-5'))
    await expect.poll(() => panel(page, 'panel-3').getAttribute('data-state')).toBe('review')
    // Two takes now: either can be shown and approved.
    expect(await panel(page, 'panel-3').getByRole('button', { name: '第 1 次结果' }).isVisible()).toBe(true)

    await panel(page, 'panel-1').getByRole('button', { name: '通过' }).click()
    await expect.poll(() => panel(page, 'panel-1').getAttribute('data-state')).toBe('approved')
    await page.getByRole('button', { name: '全部通过' }).click()
    await expect.poll(() => page.locator('[data-manga-panel][data-state="approved"]').count()).toBe(3)

    await page.getByRole('button', { name: '导出这一话' }).click()
    await expect
      .poll(() => app.calls<{ title: string; chapterNumber: number; pages: unknown[] }>('manga:export').then((calls) => calls.length))
      .toBe(1)
    const [exported] = await app.calls<{ title: string; chapterNumber: number; pages: unknown[] }>('manga:export')
    expect(exported).toMatchObject({ title: '雨夜侦探', chapterNumber: 1 })
    expect(exported!.pages).toHaveLength(1)
    await page.getByText('已导出 1 页到 /fixture/export/雨夜侦探').waitFor()
  })

  it('sends character pictures only to an engine with vision references, and says so otherwise', async () => {
    const page = await openSeries(() => {
      const { mangaSeriesFixture, engineFeaturesFixture } = window.__mock.fixtures
      const series = mangaSeriesFixture({ style: { ...mangaSeriesFixture().style, adapters: [] } })
      series.characters = series.characters.map((character) => ({ ...character, adapters: [] }))
      window.__mock.state.manga = [series]
      window.__mock.state.engineFeatures = engineFeaturesFixture({ visionReferences: false })
      localStorage.setItem('mossstudio.manga.open', 'manga-1')
    })
    await page.getByRole('heading', { name: '雨夜侦探' }).waitFor()
    await panel(page, 'panel-1').getByRole('button', { name: '生成' }).click()
    await expect.poll(() => app.calls(JOBS).then((calls) => calls.length)).toBe(1)
    const [job] = await app.calls<Record<string, unknown>>(JOBS)
    expect(job).not.toHaveProperty('visionReferences')
    expect(job).not.toHaveProperty('references')
    await page.getByText('当前引擎还不支持人物参考图，这一格只用了文字描述和 LoRA').waitFor()
  })

  it('after a restart, waits for the model library before drawing what was queued', async () => {
    const page = await openSeries(() => {
      const { mangaSeriesFixture } = window.__mock.fixtures
      const series = mangaSeriesFixture({ style: { ...mangaSeriesFixture().style, adapters: [] } })
      series.characters = series.characters.map((character) => ({ ...character, adapters: [] }))
      for (const panel of series.chapters[0]!.pages[0]!.panels) panel.state = 'queued'
      window.__mock.state.manga = [series]
      localStorage.setItem('mossstudio.manga.open', 'manga-1')
      ;(window as unknown as { heldCatalog: unknown }).heldCatalog = window.__mock.hold('models:catalog')
    })
    await page.getByRole('heading', { name: '雨夜侦探' }).waitFor()
    // The library is still being read: nothing is sent, and nothing is marked as failed.
    await page.waitForTimeout(400)
    expect(await app.calls(JOBS)).toEqual([])
    expect(await page.locator('[data-manga-panel][data-state="queued"]').count()).toBe(3)
    expect(await page.getByText('还没有可用的模型').count()).toBe(0)
    await page.evaluate(() => (window as unknown as { heldCatalog: { release: () => Promise<void> } }).heldCatalog.release())
    await expect.poll(() => app.calls(JOBS).then((calls) => calls.length)).toBe(2)
  })

  it('turns pages strictly black and white from 设定', async () => {
    const page = await openSeries(() => {
      window.__mock.state.manga = [window.__mock.fixtures.mangaSeriesFixture()]
      localStorage.setItem('mossstudio.manga.open', 'manga-1')
    })
    await page.getByRole('tab', { name: '设定' }).click()
    const toggle = page.getByRole('switch', { name: '成品为纯黑白' })
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
    await toggle.click()
    await expect
      .poll(() => app.calls<{ style: { monochrome?: boolean } }>('manga:save').then((calls) => calls.at(-1)?.style.monochrome))
      .toBe(true)
  })

  it('stays in the series when its last edits could not be saved', async () => {
    const page = await openSeries(() => {
      window.__mock.state.manga = [window.__mock.fixtures.mangaSeriesFixture()]
      localStorage.setItem('mossstudio.manga.open', 'manga-1')
    })
    await page.getByRole('tab', { name: '设定' }).click()
    await page.evaluate(() => window.__mock.fail(window.__mock.Ipc.mangaSave, { code: 'E_WRITE', message: '磁盘已满' }))
    await page.getByRole('switch', { name: '成品为纯黑白' }).click()
    await page.getByRole('button', { name: '全部漫画' }).click()
    await page.getByText('没有保存成功：磁盘已满').waitFor()
    await expect.poll(() => page.getByRole('switch', { name: '成品为纯黑白' }).getAttribute('aria-checked')).toBe('true')

    await page.evaluate(() => window.__mock.fail(window.__mock.Ipc.mangaSave, {}, { times: 0 }))
    await page.getByRole('button', { name: '全部漫画' }).click()
    await page.getByRole('button', { name: '新建漫画' }).waitFor()
    expect(await page.evaluate(() => window.__mock.state.manga[0]?.style.monochrome)).toBe(true)

    // The list shows each series as a card with its cover; a card opens its series.
    const card = page.locator('[data-manga-series="manga-1"]')
    expect(await card.getAttribute('aria-label')).toBe('雨夜侦探')
    expect(await card.innerText()).toContain('0 / 3 格')
    expect(await card.locator('img').getAttribute('src')).toContain('aki.png')
    await card.click()
    await page.getByRole('heading', { name: '雨夜侦探' }).waitFor()
  })

  it('stops adding lines and characters at the limits, and refuses to export a page whose picture is gone', async () => {
    const page = await openSeries(() => {
      const { mangaSeriesFixture } = window.__mock.fixtures
      const series = mangaSeriesFixture()
      const take = (path: string) => ({ path, width: 1024, height: 768, seed: 1, jobId: 'job-old' })
      const [first, second, third] = series.chapters[0]!.pages[0]!.panels
      first!.dialogue = Array.from({ length: 12 }, (_, i) => ({
        id: `l${i}`,
        kind: 'speech' as const,
        text: `第 ${i + 1} 句`,
        x: 0.5,
        y: 0.5,
      }))
      first!.cast = Array.from({ length: 6 }, () => ({ characterId: 'char-aki', expression: '', pose: '' }))
      for (const panel of [first!, second!, third!])
        Object.assign(panel, { state: 'approved', takes: [take('/fixture/outputs/ok.png')], chosen: 0 })
      second!.takes = [take('/fixture/outputs/missing.png')]
      window.__mock.state.manga = [series]
      localStorage.setItem('mossstudio.manga.open', 'manga-1')
    })
    await page.getByRole('heading', { name: '雨夜侦探' }).waitFor()
    const first = panel(page, 'panel-1')
    expect(await first.getByRole('button', { name: '加对白' }).isDisabled()).toBe(true)
    expect(await first.getByRole('button', { name: '加人物' }).isDisabled()).toBe(true)
    expect(await panel(page, 'panel-2').getByRole('button', { name: '加对白' }).isDisabled()).toBe(false)

    await page.getByRole('button', { name: '导出这一话' }).click()
    await page.getByText('第 1 页第 2 格的图片读不到了（可能已在「作品」里删除），请重画后再导出').waitFor()
    expect(await app.calls('manga:export')).toEqual([])
  })

  it('cuts, merges and bleeds panels, drags a gutter, and draws layouts and shots for a page', async () => {
    const page = await openSeries(() => {
      window.__mock.state.manga = [window.__mock.fixtures.mangaSeriesFixture()]
      localStorage.setItem('mossstudio.manga.open', 'manga-1')
    })
    const stored = () => page.evaluate(() => window.__mock.state.manga[0]!.chapters[0]!.pages[0]!)
    const ids = () => panels(page).evaluateAll((items) => items.map((item) => item.getAttribute('data-manga-panel')))
    const frames = page.getByRole('group', { name: '第 1 页的分格' })
    await frames.waitFor()

    await frames.getByRole('button', { name: '第 2 格' }).click()
    const tools = page.getByRole('group', { name: '第 2 格的分格' })
    expect(await tools.getByRole('button', { name: '合并' }).isDisabled()).toBe(true)
    await tools.getByRole('button', { name: '上下拆开' }).click()
    await expect.poll(async () => (await ids()).length).toBe(4)
    const [, , added] = await ids()
    expect(await ids()).toEqual(['panel-1', 'panel-2', added, 'panel-3'])
    await expect.poll(async () => (await stored()).panels.length).toBe(4)
    await tools.getByRole('button', { name: '合并' }).click()
    await expect.poll(ids).toEqual(['panel-1', 'panel-2', 'panel-3'])

    // The first panel spans the top of the page, so it can bleed.
    await frames.getByRole('button', { name: '第 1 格' }).click()
    await page.getByRole('switch', { name: '第 1 格出血' }).click()
    await expect.poll(async () => (await stored()).frames).toMatchObject({ first: { kind: 'panel', bleed: true } })

    const before = (await stored()).frames
    const across = frames.getByRole('slider', { name: '横向格线' })
    await across.focus()
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowDown')
    await expect.poll(async () => ((await stored()).frames as { ratio: number }).ratio).toBeGreaterThan((before as { ratio: number }).ratio)

    await page.getByRole('button', { name: '抽分格' }).click()
    const drawn = page.getByRole('group', { name: '抽到的分格' })
    expect(await drawn.getByRole('button').count()).toBe(8)
    await drawn.getByRole('button', { name: /^候选 3：3 格$/ }).click()
    expect(await drawn.getByRole('button', { name: /^候选 3/ }).getAttribute('aria-pressed')).toBe('true')
    const dragged = (await stored()).frames
    await page.getByRole('button', { name: '用这张' }).click()
    await expect.poll(async () => JSON.stringify((await stored()).frames) !== JSON.stringify(dragged)).toBe(true)
    expect(await ids()).toEqual(['panel-1', 'panel-2', 'panel-3'])
    expect(await drawn.count()).toBe(0)

    await page.getByRole('button', { name: '抽镜头' }).click()
    await expect.poll(async () => (await stored()).panels.every((item) => item.angle !== undefined)).toBe(true)
    const angle = (await stored()).panels[0]!.angle!
    const labels = { eye: '平视', high: '俯视', low: '仰视', side: '侧面', back: '背影', over: '过肩' }
    const picker = panel(page, 'panel-1').getByRole('combobox', { name: '角度' })
    expect(await picker.evaluate((select: HTMLSelectElement) => select.selectedOptions[0]?.textContent)).toBe(labels[angle])
  })

  it('shows a placeholder on a series card whose cover picture is gone, not a broken picture', async () => {
    const page = await openSeries(() => {
      const { mangaSeriesFixture, mangaCharacterFixture } = window.__mock.fixtures
      const gone = mangaSeriesFixture({
        id: 'manga-2',
        title: '图被删了',
        characters: [mangaCharacterFixture({ references: [{ path: '/fixture/missing/aki.png', width: 768, height: 1024 }] })],
      })
      window.__mock.state.manga = [mangaSeriesFixture(), gone]
      localStorage.removeItem('mossstudio.manga.open')
    })
    const gone = page.locator('[data-manga-series="manga-2"]')
    await gone.locator('[data-cover-missing]').waitFor()
    expect(await gone.locator('img').count()).toBe(0)
    expect(await page.locator('[data-manga-series="manga-1"] img').count()).toBe(1)
  })

  it('drops a gutter dragged with the mouse where the pointer let go, and keeps panel cards usable, with the window zoomed by 界面大小 too', async () => {
    const page = await openSeries(() => {
      window.__mock.state.manga = [window.__mock.fixtures.mangaSeriesFixture()]
      localStorage.setItem('mossstudio.manga.open', 'manga-1')
    })
    const frames = page.getByRole('group', { name: '第 1 页的分格' })
    await frames.waitFor()
    try {
      for (const [zoom, target] of [
        [1, 900],
        [1.5, 1200],
      ] as const) {
        await app.electron.evaluate(
          ({ BrowserWindow }, factor) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(factor),
          zoom,
        )
        await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBeCloseTo(zoom, 2)
        await frames.scrollIntoViewIfNeeded()
        const box = (await frames.boundingBox())!
        const scale = box.height / PAGE_HEIGHT
        const across = frames.getByRole('slider', { name: '横向格线' })
        const from = Number(await across.getAttribute('aria-valuenow'))
        const x = box.x + box.width / 4
        await page.mouse.move(x, box.y + from * scale)
        await page.mouse.down()
        await page.mouse.move(x, box.y + target * scale, { steps: 8 })
        await page.mouse.up()
        // A panel card keeps room to write in: next to the page at 100 %, below it when zoomed.
        const describe = panel(page, 'panel-1').getByLabel('画面描述')
        expect(await describe.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(240)
        // Within two screen pixels of the pointer.
        await expect.poll(async () => Math.abs(Number(await across.getAttribute('aria-valuenow')) - target)).toBeLessThanOrEqual(2 / scale)
      }
    } finally {
      await app.electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1))
    }
  })

  it('does not offer to cut a panel that is already as narrow as a panel may be', async () => {
    const page = await openSeries(() => {
      window.__mock.state.manga = [window.__mock.fixtures.mangaSeriesFixture()]
      localStorage.setItem('mossstudio.manga.open', 'manga-1')
    })
    const frames = page.getByRole('group', { name: '第 1 页的分格' })
    await frames.waitFor()
    // Right to left: the second panel is the right one of the lower row; move the gutter right until it stops.
    await frames.getByRole('slider', { name: '竖向格线' }).focus()
    for (let i = 0; i < 45; i += 1) await page.keyboard.press('ArrowRight')
    await frames.getByRole('button', { name: '第 2 格' }).click()
    const tools = page.getByRole('group', { name: '第 2 格的分格' })
    const across = tools.getByRole('button', { name: '左右拆开' })
    expect(await across.isDisabled()).toBe(true)
    expect(await across.getAttribute('title')).toBe('这一格太窄，拆不开了')
    expect(await tools.getByRole('button', { name: '上下拆开' }).isDisabled()).toBe(false)
  })

  it('adds reference pictures and outfits to a character card', async () => {
    const page = await openSeries(() => {
      const { mangaSeriesFixture } = window.__mock.fixtures
      window.__mock.state.manga = [mangaSeriesFixture()]
      window.__mock.state.pickedImages = ['/home/user/ren-front.png']
      localStorage.setItem('mossstudio.manga.open', 'manga-1')
    })
    await page.getByRole('tab', { name: /人物/ }).click()
    await page.getByRole('button', { name: /莲/ }).click()
    const card = page.getByRole('region', { name: '人物卡：莲' })
    // The card says which picture works: whatever else a picture shows ends up in every panel.
    await card.getByText(/正面、纯白背景的头肩像/).waitFor()
    await card.getByRole('button', { name: '添加参考图' }).click()
    await card.getByRole('img', { name: '参考图 1' }).waitFor()
    expect(await app.calls('studio:import-image')).toEqual([{ projectId: 'project-manga', path: '/home/user/ren-front.png' }])
    // With a picture comes its strength: lowered, it is saved on the card and later sent as the engine's weight.
    await card.getByRole('slider', { name: '参考强度' }).fill('0.5')
    await expect
      .poll(() =>
        app
          .calls<{ characters: Array<{ id: string; referenceStrength?: number }> }>('manga:save')
          .then((calls) => calls.at(-1)?.characters.find((item) => item.id === 'char-ren')?.referenceStrength),
      )
      .toBe(0.5)

    await card.getByRole('button', { name: '添加服装' }).click()
    await card.getByLabel('样子').fill('白大褂')
    // The first outfit becomes the default.
    expect(await card.getByRole('switch', { name: /设为默认/ }).getAttribute('aria-checked')).toBe('true')
    await expect
      .poll(() =>
        app
          .calls<{ characters: Array<{ id: string; references: unknown[]; outfits: Array<{ prompt: string }> }> }>('manga:save')
          .then((calls) => calls.at(-1)?.characters.find((item) => item.id === 'char-ren')),
      )
      .toMatchObject({ references: [{ path: '/fixture/projects/project-manga/assets/ren-front.png' }], outfits: [{ prompt: '白大褂' }] })
  })
})
