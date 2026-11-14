import { describe, expect, it } from 'vitest'
import { defaultBalloonPlaces, layoutBalloon, nearestSpot, shoutOutline, wrapText } from '@shared/manga/balloons'

/** Every character is 10 px wide. */
const measure = (text: string): number => text.length * 10

describe('wrapText', () => {
  it('breaks Chinese between any characters and keeps Latin words whole', () => {
    expect(wrapText('今天的雨下得特别大', 40, measure)).toEqual(['今天的雨', '下得特别', '大'])
    expect(wrapText('hello world ok', 60, measure)).toEqual(['hello', 'world', 'ok'])
    expect(wrapText('第一行\n第二行', 100, measure)).toEqual(['第一行', '第二行'])
    // Closing punctuation never starts a line, and an opening bracket never ends one (禁则).
    expect(wrapText('这些脚印是新的。', 70, measure)).toEqual(['这些脚印是新的。'])
    expect(wrapText('这次你跑不掉了！', 40, measure)).toEqual(['这次你跑', '不掉了！'])
    expect(wrapText('他说「快跑」', 30, measure)).toEqual(['他说', '「快跑」'])
  })

  it('splits a word that is wider than the line', () => {
    expect(wrapText('abcdefghij', 40, measure)).toEqual(['abcd', 'efgh', 'ij'])
  })
})

describe('balloon placement', () => {
  it('fills the corners in reading order before the edges', () => {
    expect(defaultBalloonPlaces(3, 'rtl')).toEqual([
      { x: 1, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ])
    expect(defaultBalloonPlaces(1, 'ltr')).toEqual([{ x: 0, y: 0 }])
    expect(defaultBalloonPlaces(6, 'ltr').slice(4)).toEqual([
      { x: 0.5, y: 0 },
      { x: 0.5, y: 1 },
    ])
    expect(defaultBalloonPlaces(0, 'rtl')).toEqual([])
  })

  it('puts a corner balloon against its corner, not over the middle', () => {
    const measure = (size: number) => (text: string) => text.length * size
    const corner = layoutBalloon({ kind: 'speech', text: '这里有脚印！即使雨水冲刷了旧港口的栈道', x: 1, y: 0 }, 1200, 860, measure)
    // Its right edge sits a margin inside the panel, and it stays in the right half.
    expect(1200 - (corner.cx + corner.rx)).toBeCloseTo(Math.round(corner.fontSize * 0.6), 0)
    expect(corner.cx - corner.rx).toBeGreaterThan(600)
    expect(corner.cy - corner.ry).toBeCloseTo(Math.round(corner.fontSize * 0.6), 0)
    const middle = layoutBalloon({ kind: 'speech', text: '中间', x: 0.5, y: 0.5 }, 1200, 860, measure)
    expect(middle.cx).toBeCloseTo(600)
  })

  it('names spots', () => {
    expect(nearestSpot(0.8, 0.16).value).toBe('tr')
    expect(nearestSpot(0.45, 0.55).label).toBe('中间')
  })

  it('keeps a balloon inside its panel', () => {
    const box = layoutBalloon(
      { kind: 'speech', text: '很长很长的一句台词，要换好几行才能放下', x: 1, y: 0 },
      600,
      400,
      (size) => (text) => text.length * size,
    )
    expect(box.cx + box.rx).toBeLessThanOrEqual(600)
    expect(box.cy - box.ry).toBeGreaterThanOrEqual(0)
    expect(box.lines.length).toBeGreaterThan(1)
    const narration = layoutBalloon({ kind: 'narration', text: '旁白', x: 0.5, y: 0.5 }, 600, 400, (size) => (text) => text.length * size)
    expect(narration.rx).toBeLessThan(box.rx)
  })

  it('draws a shout as a closed star around the ellipse', () => {
    const points = shoutOutline(0, 0, 10, 10, 4)
    expect(points).toHaveLength(8)
    expect(points[0]![0]).toBeCloseTo(11.8)
  })
})
