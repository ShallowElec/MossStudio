/**
 * 漫画 fixtures: a small series with two characters and one storyboarded
 * chapter, shared by the unit tests, the mock backend and the E2E specs.
 */
import { templateById } from '@shared/manga/layouts'
import { MANGA_SCHEMA_VERSION, emptyPanel, type MangaCharacter, type MangaPanel, type MangaSeries } from '@shared/manga/model'

const NOW = '2026-11-04T08:00:00.000Z'

export function mangaCharacterFixture(overrides: Partial<MangaCharacter> = {}): MangaCharacter {
  return {
    id: 'char-aki',
    name: '阿秋',
    role: '主角',
    appearance: '短黑发，琥珀色眼睛，左眉有小疤',
    personality: '倔强，嘴硬心软',
    triggerWords: 'akiOC',
    references: [{ path: '/fixture/projects/project-manga/assets/aki.png', width: 768, height: 1024 }],
    outfits: [
      { id: 'outfit-school', name: '校服', prompt: '深蓝色水手服，红色领结' },
      { id: 'outfit-coat', name: '风衣', prompt: '卡其色长风衣' },
    ],
    defaultOutfitId: 'outfit-school',
    adapters: [{ id: 'aki-lora', strength: 0.8 }],
    ...overrides,
  }
}

export function mangaPanelFixture(id: string, overrides: Partial<MangaPanel> = {}): MangaPanel {
  return { ...emptyPanel(id), scene: `画面 ${id}`, ...overrides }
}

export function mangaSeriesFixture(overrides: Partial<MangaSeries> = {}): MangaSeries {
  return {
    schemaVersion: MANGA_SCHEMA_VERSION,
    id: 'manga-1',
    title: '雨夜侦探',
    logline: '少女侦探在雨城追查失踪案',
    readingDirection: 'rtl',
    projectId: 'project-manga',
    style: { prompt: '黑白漫画，网点，粗线条', negative: '彩色', adapters: [{ id: 'ink-style', strength: 1 }], steps: 20, cfg: 4.5 },
    characters: [
      mangaCharacterFixture(),
      mangaCharacterFixture({
        id: 'char-ren',
        name: '莲',
        role: '搭档',
        appearance: '银色长发，戴眼镜',
        personality: '冷静',
        triggerWords: '',
        references: [],
        outfits: [],
        defaultOutfitId: undefined,
        adapters: [],
      }),
    ],
    chapters: [
      {
        id: 'chapter-1',
        number: 1,
        title: '雨中的委托',
        outline: '阿秋在雨夜接到委托，和莲一起去旧港口。',
        summary: '',
        pages: [
          {
            id: 'page-1',
            frames: templateById('wide-then-two')!.frames,
            panels: [
              mangaPanelFixture('panel-1', {
                scene: '雨夜的街道，霓虹灯倒映在积水里',
                shot: 'wide',
                cast: [{ characterId: 'char-aki', expression: '皱眉', pose: '撑伞' }],
                dialogue: [{ id: 'line-1', kind: 'narration', text: '那天，雨一直没停。', x: 0.8, y: 0.16 }],
              }),
              mangaPanelFixture('panel-2', {
                scene: '事务所门口，莲推门进来',
                cast: [{ characterId: 'char-ren', expression: '', pose: '推门' }],
                dialogue: [{ id: 'line-2', kind: 'speech', speakerId: 'char-ren', text: '有新委托。', x: 0.5, y: 0.2 }],
              }),
              mangaPanelFixture('panel-3', {
                scene: '阿秋的眼睛特写',
                shot: 'extreme',
                cast: [{ characterId: 'char-aki', expression: '惊讶', pose: '' }],
              }),
            ],
          },
        ],
      },
    ],
    facts: [{ id: 'fact-1', text: '阿秋左眉的疤是十岁时留下的' }],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}
