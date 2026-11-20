import { describe, expect, it } from 'vitest'
import {
  BOARD_GAP,
  cardHeight,
  cardWidth,
  imageNodeSize,
  IMAGE_NODE_MAX_EDGE,
  IMAGE_NODE_MIN_EDGE,
  toBoardPoint,
} from '@renderer/pages/studio/boardLayout'
import { boardTakesDrag, dropPositions, isImageFile, sortBoardDrop } from '@renderer/pages/studio/imageNodes'

describe('studio/image nodes', () => {
  it('accepts picture files by type or name', () => {
    expect(isImageFile({ type: 'image/png', name: '' })).toBe(true)
    expect(isImageFile({ type: '', name: 'C:\\pics\\cat.JPG' })).toBe(true)
    expect(isImageFile({ type: 'text/plain', name: 'notes.txt' })).toBe(false)
    expect(isImageFile({ type: 'image/svg+xml', name: 'logo.svg' })).toBe(false)
  })

  it('sizes a card from the picture, keeping its shape', () => {
    expect(imageNodeSize({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 })
    expect(imageNodeSize({ width: 4000, height: 2000 })).toEqual({ width: IMAGE_NODE_MAX_EDGE, height: IMAGE_NODE_MAX_EDGE / 2 })
    expect(imageNodeSize({ width: 3000, height: 100 })).toEqual({ width: IMAGE_NODE_MAX_EDGE, height: IMAGE_NODE_MIN_EDGE })
    expect(imageNodeSize({ width: 0, height: 0 })).toEqual({ width: IMAGE_NODE_MIN_EDGE, height: IMAGE_NODE_MIN_EDGE })
  })

  it('centres the first dropped picture on the drop point and lines up the rest', () => {
    const pictures = [
      { width: 800, height: 600 },
      { width: 512, height: 512 },
    ]
    const [first, second] = dropPositions(pictures, { x: 1000, y: 500 })
    const size = imageNodeSize(pictures[0]!)
    expect(first).toEqual({ x: 1000 - cardWidth(size) / 2, y: Math.round(500 - cardHeight(size) / 2) })
    expect(second!.x).toBe(first!.x + cardWidth(size) + BOARD_GAP)
  })

  it('turns a viewport point into a board point', () => {
    expect(toBoardPoint({ zoom: 0.5, pan: { x: 100, y: 40 } }, 300, 140)).toEqual({ x: 400, y: 200 })
  })
})

describe('a drop on the board', () => {
  it('shows the copy cursor for pictures and untyped files (models, folders), not for other kinds', () => {
    expect(boardTakesDrag(['image/png', ''])).toBe(true)
    expect(boardTakesDrag(['application/octet-stream'])).toBe(true)
    expect(boardTakesDrag(['image/png', 'application/pdf'])).toBe(false)
    expect(boardTakesDrag(['text/plain'])).toBe(false)
  })

  it('sends model files and folders to 导入模型 and refuses the rest out loud (B10: they were dropped silently)', () => {
    const files = [
      { name: 'cat.png', type: 'image/png' },
      { name: 'moss_image_sft_int8.safetensors', type: '' },
      { name: 'ComfyUI', type: '', folder: true },
      { name: 'notes.txt', type: 'text/plain' },
    ]
    const sorted = sortBoardDrop(files)
    expect(sorted.images.map((file) => file.name)).toEqual(['cat.png'])
    expect(sorted.models.map((file) => file.name)).toEqual(['moss_image_sft_int8.safetensors', 'ComfyUI'])
    expect(sorted.other.map((file) => file.name)).toEqual(['notes.txt'])
  })
})
