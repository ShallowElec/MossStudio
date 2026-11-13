import { describe, expect, it } from 'vitest'
import { defaultBalloonPlaces, layoutBalloon, shoutOutline, wrapText } from '@shared/manga/balloons'

/** Every character is 10 px wide. */
const measure = (text: string): number => text.length * 10

describe('wrapText', () => {
  it('breaks Chinese between any characters and keeps Latin words whole', () => {
    expect(wrapText('今天的雨下得特别大', 40, measure)).toEqual(['今天的雨', '下得特别', '大'])
    expect(wrapText('hello world ok', 60, measure)).toEqual(['hello', 'world', 'ok'])
    expect(wrapText('第一行\n第二行', 100, measure)).toEqual(['第一行', '第二行'])
  })

  it('splits a word that is wider than the line', () => {
    expect(wrapText('abcdefghij', 40, measure)).toEqual(['abcd', 'efgh', 'ij'])
  })
})

describe('balloon placement', () => {
  it('starts on the reading side and alternates height', () => {
    const rtl = defaultBalloonPlaces(3, 'rtl')
    expect(rtl[0]!.x).toBeGreaterThan(rtl[2]!.x)
    expect(rtl.map((place) => place.y)).toEqual([0.16, 0.3, 0.16])
    expect(defaultBalloonPlaces(1, 'ltr')).toEqual([{ x: 0.18, y: 0.16 }])
    expect(defaultBalloonPlaces(0, 'rtl')).toEqual([])
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
