/**
 * Every page and key state, in both themes: the visual rules hold (no borders,
 * only theme tokens, readable text, no sideways overflow) and a screenshot is
 * written to E2E_SHOTS_DIR as <page>-<state>-<theme>.png.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { settle, useApp, type E2eApp, type OpenOptions } from '../support/app'
import { audit, clippedText, expectVisualRules } from '../support/visual'

interface Stop {
  page: string
  state: string
  open: OpenOptions
  /** Edit the mock state before the app starts (opens with defer). */
  seed?: (page: Page) => Promise<void>
  /** Bring the page into the state worth checking. */
  prepare?: (page: Page) => Promise<void>
}

const ALL_FEATURES = { trainingEnabled: true, remoteHostsEnabled: true, gbcEnabled: true, lanWebEnabled: true }

/** A project whose canvas has a description, two regions and a finished run with four outputs. */
async function seedStudio(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { canvasFixture, projectFixture, jobFixture } = window.__mock.fixtures
    const outputs = [0, 1, 2, 3].map((index) => ({
      path: `/fixture/outputs/run-${index}.png`,
      width: 1024,
      height: 1024,
      seed: 40 + index,
    }))
    const layers = [
      { id: 'r1', kind: 'object', caption: '一只橘猫', bbox: [80, 120, 560, 640], visible: true },
      { id: 'r2', kind: 'text', caption: '标题', text: '夏日', bbox: [600, 80, 960, 300], visible: true },
    ]
    const source = canvasFixture({
      id: 'c1',
      title: '画面 1',
      prompt: '阳光明媚的客厅',
      summary: { caption: '阳光明媚的客厅', meta: [], canvas: 'single' },
      layers: layers as never,
      seed: 40,
    })
    const result = canvasFixture({
      id: 'c2',
      kind: 'result',
      title: '画面 1 · 结果',
      x: 1120,
      y: 0,
      prompt: '阳光明媚的客厅',
      summary: { caption: '阳光明媚的客厅', meta: [], canvas: 'single' },
      layers: layers as never,
      seed: 40,
      negative: 'blurry, watermark',
      jobId: 'job-done',
      jobState: 'succeeded',
      outputs,
      sourceCanvasId: 'c1',
    } as never)
    window.__mock.state.projects = [projectFixture({ id: 'p1', name: '海报', canvases: [source, result], selectedCanvasId: 'c1' })]
    window.__mock.state.jobs = [
      jobFixture({
        id: 'job-done',
        state: 'succeeded',
        stage: 'ready',
        canvasId: 'c2',
        projectId: 'p1',
        params: { ...jobFixture().params, prompt: '阳光明媚的客厅', negativePrompt: 'blurry, watermark' },
        outputs,
        endedAt: '2026-11-01T00:00:20.000Z',
      }),
    ]
  })
}

/** A series with its first chapter storyboarded, one panel drawn and waiting for review, reopened where it was left. */
async function seedManga(page: Page): Promise<void> {
  await page.evaluate(() => {
    const series = window.__mock.fixtures.mangaSeriesFixture()
    const first = series.chapters[0]!.pages[0]!.panels[0]!
    first.state = 'review'
    first.takes = [{ path: '/fixture/outputs/run-0.png', width: 1024, height: 768, seed: 4, jobId: 'job-done' }]
    window.__mock.state.manga = [series]
    localStorage.setItem('mossstudio.manga.open', series.id)
  })
}

/** A text-only model and one that sees pictures. */
async function seedProviders(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { aiProviderFixture } = window.__mock.fixtures
    window.__mock.state.aiProviders = [
      aiProviderFixture({ id: 'local', kind: 'ollama', name: 'Ollama', model: 'llama3.1' }),
      aiProviderFixture({ id: 'claude', kind: 'anthropic', name: 'Anthropic', model: 'claude-sonnet-4-5' }),
    ]
  })
}

async function clearManga(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.removeItem('mossstudio.manga.open'))
}

async function seedJobs(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { jobFixture, jobLogFixture } = window.__mock.fixtures
    window.__mock.state.jobs = [
      jobFixture({
        id: 'job-run',
        state: 'running',
        stage: 'denoise',
        progress: { stage: 'denoise', current: 10, total: 28, percent: 36 },
      }),
      jobFixture({ id: 'job-old', state: 'succeeded', stage: 'ready', endedAt: '2026-11-01T00:00:00.000Z' }),
    ]
    window.__mock.state.jobLogs = { 'job-run': jobLogFixture('job-run', 6) }
  })
}

/** First use while preparing: the base model half downloaded, the trainer still to come. */
async function seedPreparing(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { downloadFixture } = window.__mock.fixtures
    const training = window.__mock.state.training
    training.readiness = { ...training.readiness, prepare: { running: true, step: 'model', error: null } }
    window.__mock.state.downloads = [
      downloadFixture({
        targetId: 'moss-base-dit',
        label: 'MOSS-Image Base',
        state: 'running',
        bytes: 4_400_000_000,
        speedBps: 38 * 1024 ** 2,
      }),
    ]
  })
}

/** A training whose pictures are still being prepared: no job yet. */
async function seedStarting(page: Page): Promise<void> {
  await page.evaluate(() => {
    const training = window.__mock.state.training
    training.projects = training.projects.map((project) => (project.id === 'tp-aming' ? { ...project, state: 'starting' } : project))
  })
}

async function seedRemote(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__mock.state.hosts = [window.__mock.fixtures.sshHostFixture()]
  })
}

/** 高级 in the training editor is remembered; put it in the state the stop shows. */
async function setAdvanced(page: Page, open: boolean): Promise<void> {
  const advanced = page.getByRole('button', { name: /^高级/ })
  if ((await advanced.getAttribute('aria-expanded')) !== String(open)) await advanced.click()
  if (!open) {
    const list = page.getByRole('group', { name: '图片显示方式' }).getByRole('button', { name: '网格' })
    if ((await list.getAttribute('aria-pressed')) !== 'true') await list.click()
  }
}

const openActivity =
  (tab: string) =>
  async (page: Page): Promise<void> => {
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '活动' }).click()
    await page
      .getByRole('complementary', { name: '活动' })
      .getByRole('tab', { name: new RegExp(tab) })
      .click()
  }

const STOPS: Stop[] = [
  { page: 'setup', state: 'first-run', open: { scenario: 'firstRun', route: '/setup' } },
  { page: 'setup', state: 'no-gpu', open: { scenario: 'noGpu', route: '/setup' } },
  { page: 'setup', state: 'installing', open: { scenario: 'engineInstalling', route: '/setup' } },
  { page: 'setup', state: 'cannot-run-gpu', open: { scenario: 'machineUnusableGpu', route: '/setup' } },
  { page: 'setup', state: 'cannot-run-memory', open: { scenario: 'machineTinyGpu', route: '/setup' } },
  { page: 'setup', state: 'slow', open: { scenario: 'machineIntel', route: '/setup' } },
  { page: 'setup', state: 'low-disk', open: { scenario: 'lowDisk', route: '/setup' } },
  { page: 'studio', state: 'empty', open: { scenario: 'ready', route: '/studio' } },
  { page: 'studio', state: 'model-missing', open: { scenario: 'engineInstalledModelMissing', route: '/studio' } },
  {
    page: 'studio',
    state: 'regions-and-outputs',
    open: { scenario: 'ready', route: '/studio' },
    seed: seedStudio,
    prepare: async (page) => {
      await page.locator('[data-region-id="r1"]').first().click()
    },
  },
  {
    page: 'studio',
    state: 'viewer',
    open: { scenario: 'ready', route: '/studio' },
    seed: seedStudio,
    prepare: async (page) => {
      // The run is in 画面 1's filmstrip (the newest pictures in view): double-click one to open it.
      await page.locator('article[data-canvas-card="c1"] footer').getByRole('button', { name: '第 3 张' }).dblclick()
    },
  },
  {
    page: 'studio',
    state: 'assistant',
    open: { scenario: 'ready', route: '/studio' },
    prepare: async (page) => {
      await page.getByRole('button', { name: '助手', exact: true }).click()
    },
  },
  {
    page: 'studio',
    state: 'project-menu',
    open: { scenario: 'ready', route: '/studio' },
    seed: seedStudio,
    prepare: async (page) => {
      await page.locator('[data-project-switcher]').click()
    },
  },
  { page: 'manga', state: 'empty', open: { scenario: 'ready', route: '/manga' }, seed: clearManga },
  {
    page: 'manga',
    state: 'list',
    open: { scenario: 'ready', route: '/manga' },
    seed: async (page) => {
      await seedManga(page)
      await clearManga(page)
    },
  },
  { page: 'manga', state: 'chapter', open: { scenario: 'ready', route: '/manga' }, seed: seedManga },
  {
    page: 'manga',
    state: 'panels',
    open: { scenario: 'ready', route: '/manga' },
    seed: seedManga,
    prepare: async (page) => {
      await page.locator('[data-manga-panel="panel-1"]').scrollIntoViewIfNeeded()
    },
  },
  {
    page: 'manga',
    state: 'characters',
    open: { scenario: 'ready', route: '/manga' },
    seed: seedManga,
    prepare: async (page) => {
      await page.getByRole('tab', { name: /人物/ }).click()
    },
  },
  {
    page: 'manga',
    state: 'memory',
    open: { scenario: 'ready', route: '/manga' },
    seed: seedManga,
    prepare: async (page) => {
      await page.getByRole('tab', { name: '剧情记忆' }).click()
    },
  },
  {
    page: 'manga',
    state: 'needs-model',
    open: { scenario: 'ready', route: '/manga' },
    seed: seedManga,
    prepare: async (page) => {
      await page.getByRole('button', { name: '写入剧情记忆' }).click()
      await page.getByRole('dialog', { name: '写入剧情记忆要用语言模型' }).waitFor()
    },
  },
  {
    page: 'manga',
    state: 'settings',
    open: { scenario: 'ready', route: '/manga' },
    seed: seedManga,
    prepare: async (page) => {
      await page.getByRole('tab', { name: '设定' }).click()
    },
  },
  { page: 'library', state: 'list', open: { scenario: 'ready', route: '/library' } },
  {
    page: 'library',
    state: 'detail',
    open: { scenario: 'ready', route: '/library' },
    prepare: async (page) => {
      await page.locator('[data-library-item]').first().click()
    },
  },
  { page: 'library', state: 'empty', open: { scenario: 'firstRun', route: '/library', settings: { onboardingState: 'completed' } } },
  { page: 'models', state: 'ready', open: { scenario: 'ready', route: '/models' } },
  { page: 'models', state: 'missing', open: { scenario: 'engineInstalledModelMissing', route: '/models' } },
  { page: 'models', state: 'partial', open: { scenario: 'modelPartiallyDownloaded', route: '/models' } },
  {
    page: 'models',
    state: 'lora',
    open: { scenario: 'ready', route: '/models' },
    prepare: async (page) => {
      await page.getByRole('tab', { name: 'LoRA' }).click()
    },
  },
  {
    page: 'models',
    state: 'advanced',
    open: { scenario: 'ready', route: '/models' },
    prepare: async (page) => {
      await page.getByRole('button', { name: /高级/ }).click()
      await page.getByText('主模型文件夹', { exact: true }).scrollIntoViewIfNeeded()
    },
  },
  { page: 'models', state: 'remote', open: { scenario: 'remoteHost', route: '/models', settings: { remoteHostsEnabled: true } } },
  { page: 'training', state: 'first-use', open: { scenario: 'trainingNotPrepared', route: '/training' } },
  { page: 'training', state: 'preparing', open: { scenario: 'trainingNotPrepared', route: '/training' }, seed: seedPreparing },
  {
    page: 'training',
    state: 'blocked',
    open: { scenario: 'trainingBlocked', route: '/training', settings: ALL_FEATURES },
    seed: seedRemote,
  },
  { page: 'training', state: 'start', open: { scenario: 'ready', route: '/training', settings: { trainingEnabled: true } } },
  { page: 'training', state: 'home', open: { scenario: 'trainings', route: '/training' } },
  {
    page: 'training',
    state: 'editor',
    open: { scenario: 'trainings', route: '/training/tp-aming' },
    prepare: async (page) => setAdvanced(page, false),
  },
  {
    page: 'training',
    state: 'editor-advanced',
    open: { scenario: 'trainings', route: '/training/tp-aming' },
    prepare: async (page) => {
      await setAdvanced(page, true)
      await page.getByRole('group', { name: '图片显示方式' }).getByRole('button', { name: '列表' }).click()
    },
  },
  { page: 'training', state: 'starting', open: { scenario: 'trainings', route: '/training/tp-aming' }, seed: seedStarting },
  { page: 'training', state: 'running', open: { scenario: 'trainings', route: '/training/tp-juzi' } },
  { page: 'training', state: 'done', open: { scenario: 'trainings', route: '/training/tp-watercolor' } },
  { page: 'training', state: 'failed', open: { scenario: 'trainings', route: '/training/tp-film' } },
  { page: 'settings', state: 'general', open: { scenario: 'ready', route: '/settings/general' } },
  { page: 'settings', state: 'devices', open: { scenario: 'ready', route: '/settings/devices' } },
  {
    page: 'settings',
    state: 'devices-advanced',
    open: { scenario: 'ready', route: '/settings/devices' },
    prepare: async (page) => {
      await page.getByRole('button', { name: /高级/ }).click()
    },
  },
  { page: 'settings', state: 'devices-remote', open: { scenario: 'remoteHost', route: '/settings/devices', settings: ALL_FEATURES } },
  { page: 'settings', state: 'storage', open: { scenario: 'ready', route: '/settings/storage' } },
  { page: 'settings', state: 'network', open: { scenario: 'ready', route: '/settings/network' } },
  { page: 'settings', state: 'llm-empty', open: { scenario: 'ready', route: '/settings/llm' } },
  { page: 'settings', state: 'llm', open: { scenario: 'ready', route: '/settings/llm' }, seed: seedProviders },
  { page: 'settings', state: 'features', open: { scenario: 'ready', route: '/settings/features', settings: ALL_FEATURES } },
  { page: 'settings', state: 'updates', open: { scenario: 'updateAvailable', route: '/settings/updates' } },
  { page: 'settings', state: 'about', open: { scenario: 'ready', route: '/settings/about' } },
  { page: 'settings', state: 'training', open: { scenario: 'remoteHost', route: '/settings/training', settings: ALL_FEATURES } },
  {
    page: 'activity',
    state: 'jobs',
    open: { scenario: 'ready', route: '/studio' },
    seed: seedJobs,
    prepare: async (page) => {
      await openActivity('任务')(page)
      await page.locator('[data-job-row="job-run"] button[aria-expanded]').click()
    },
  },
  { page: 'activity', state: 'problems', open: { scenario: 'jobFailure', route: '/studio' }, prepare: openActivity('问题') },
  {
    page: 'titlebar',
    state: 'gpu',
    open: { scenario: 'ready', route: '/library' },
    prepare: async (page) => {
      await page.locator('[data-perf-monitor]').click()
    },
  },
]

async function visit(app: E2eApp, stop: Stop, options: Partial<OpenOptions>): Promise<Page> {
  const page = await app.open({ ...stop.open, ...options, defer: Boolean(stop.seed) })
  if (stop.seed) {
    await stop.seed(page)
    await app.start()
  }
  if (stop.prepare) await stop.prepare(page)
  await settle(page, 150)
  return page
}

for (const theme of ['light', 'dark'] as const) {
  describe(`visual rules (${theme})`, () => {
    const app = useApp()
    for (const stop of STOPS) {
      it(`${stop.page} · ${stop.state}`, async () => {
        const page = await visit(app, stop, { theme })
        expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme)
        await app.screenshot(`${stop.page}-${stop.state}-${theme}`)
        const clipped = await clippedText(page)
        if (clipped.length) console.warn(`${stop.page}-${stop.state}-${theme}: text cut off without an ellipsis\n  ${clipped.join('\n  ')}`)
        // Every channel the page used is one the main process answers.
        expect(await page.evaluate(() => [...new Set(window.__mock.backend.unhandled)])).toEqual([])
        await expectVisualRules(page, `${stop.page} · ${stop.state} · ${theme}`)
      })
    }
  })
}

describe('no horizontal overflow at the window sizes we support', () => {
  const app = useApp()
  for (const size of [
    { width: 1280, height: 760 },
    { width: 1600, height: 1000 },
  ]) {
    for (const stop of STOPS) {
      it(`${size.width}×${size.height} ${stop.page} · ${stop.state}`, async () => {
        const page = await visit(app, stop, { theme: 'dark', size })
        const overflow = await page.evaluate(() => ({
          doc: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
          width: window.innerWidth,
        }))
        expect(overflow.doc).toBeLessThanOrEqual(overflow.width)
        expect(overflow.body).toBeLessThanOrEqual(overflow.width)
        if (size.width === 1280) await app.screenshot(`${stop.page}-${stop.state}-dark-1280x760`)
        expect((await audit(page)).filter((item) => item.rule === 'overflow')).toEqual([])
      })
    }
  }
})

describe('the audit itself', () => {
  const app = useApp()

  it('catches each kind of violation it is meant to catch', async () => {
    const page = await app.open({ scenario: 'ready', route: '/settings/about', theme: 'dark' })
    await page.evaluate(() => {
      const host = document.createElement('div')
      host.id = 'audit-probe'
      host.style.cssText = 'position:fixed;left:0;top:0;width:900px;background:var(--surface);z-index:999'
      host.innerHTML = `
        <div id="p-border" style="border:1px solid rgb(255 255 255 / 0.1);height:10px"></div>
        <div id="p-ring" style="box-shadow:0 0 0 1px rgb(255 255 255 / 0.08);height:10px"></div>
        <hr id="p-hr" style="border:0;height:1px;background:var(--well)">
        <span id="p-sky" style="color:rgb(125 211 252)">old sky text</span>
        <div id="p-overlay" style="background:rgb(255 255 255 / 0.03);height:10px"></div>
        <span id="p-contrast" style="color:var(--ink-2);background:var(--ink)">hard to read</span>
        <span id="p-out" style="position:fixed;left:1500px;top:0;white-space:nowrap;color:var(--ink)">sticks out of the window on purpose</span>`
      document.body.appendChild(host)
    })
    const found = await audit(page)
    const by = (rule: string, id: string) => found.some((item) => item.rule === rule && item.element.includes(`#${id}`))
    expect(by('border', 'p-border')).toBe(true)
    expect(by('border', 'p-ring')).toBe(true)
    expect(by('hr', 'p-hr')).toBe(true)
    expect(by('palette', 'p-sky')).toBe(true)
    expect(by('palette', 'p-overlay')).toBe(true)
    expect(by('contrast', 'p-contrast')).toBe(true)
    expect(by('overflow', 'p-out')).toBe(true)
    // ...and nothing else on the page.
    expect(found.filter((item) => !item.element.includes('#p-'))).toEqual([])
  })
})
