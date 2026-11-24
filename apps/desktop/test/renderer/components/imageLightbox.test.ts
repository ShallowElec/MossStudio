import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ImageLightbox, openImagePreview } from '@renderer/components/common/ImageLightbox'
import { Ipc } from '@shared/channels'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLElement, trigger: HTMLButtonElement, root: Root
const invoke = vi.fn(async () => ({ ok: true, data: true }))
const first = { path: '/pictures/first.png', title: '第一张', artwork: true, width: 200, height: 100 }
const second = { ...first, path: '/pictures/second.png', title: '第二张' }
const open = (): void => act(() => openImagePreview({ ...first, gallery: [first, second] }))
const image = (): HTMLImageElement => document.querySelector('dialog img')!
const key = (key: string, ctrlKey = false): void => {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true }))
}
const button = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(
    (el) => el.getAttribute('aria-label') === label || el.textContent === label,
  )!
beforeEach(() => {
  host = document.createElement('div')
  trigger = document.createElement('button')
  document.body.append(host, trigger)
  root = createRoot(host)
  act(() => root.render(createElement(ImageLightbox)))
  trigger.focus()
  vi.stubGlobal('clover', { invoke })
  invoke.mockClear()
  // The exit animation is its own test; elsewhere a closed preview leaves at once.
  document.documentElement.dataset.uiAnimation = 'off'
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  trigger.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
const refuse = (code: string, message: string): void => {
  invoke.mockResolvedValueOnce({ ok: false, error: { code, message } } as never)
}
/** A decoded picture and a canvas that records how it was drawn; happy-dom has neither. */
const decoded = () => {
  Object.defineProperties(image(), { naturalWidth: { value: 200 }, naturalHeight: { value: 100 } })
  const context = { filter: 'none', drawImage: vi.fn() }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done) => done(new Blob([], { type: 'image/png' })))
  const write = vi.spyOn(navigator.clipboard, 'write').mockResolvedValue()
  return { context, write }
}
it('opens only when requested, and restores focus after Escape or pressing the background', () => {
  expect(document.querySelector('dialog')).toBeNull()
  open()
  expect(image().src).toBe('clover://local?path=%2Fpictures%2Ffirst.png')
  act(() => key('Escape'))
  expect(document.querySelector('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  open()
  act(() => document.querySelector<HTMLElement>('[data-preview-stage]')!.click())
  expect(document.querySelector('dialog')).toBeNull()
})
it('uses actual image size at 100%, clamps wheel and button zoom and fits again', () => {
  open()
  act(() => button('100%').click())
  expect(image().style.width).toBe('200px')
  act(() => button('放大').click())
  expect(image().style.width).toBe('250px')
  for (let i = 0; i < 20; i++)
    act(() => {
      image().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
    })
  expect(image().style.width).toBe('800px')
  for (let i = 0; i < 20; i++) act(() => button('缩小').click())
  expect(image().style.width).toBe('50px')
  act(() => button('适应屏幕').click())
  expect(image().style.width).toBe('')
})
it('copies the current image through native IPC by button and Ctrl+C, not the previous gallery entry', async () => {
  open()
  await act(async () => button('复制图片').click())
  expect(invoke).toHaveBeenLastCalledWith(Ipc.galleryCopyImage, { path: first.path })
  expect(document.querySelector('dialog')?.textContent).toContain('已复制图片')
  act(() => key('ArrowRight'))
  expect(image().alt).toBe(second.title)
  await act(async () => key('c', true))
  expect(invoke).toHaveBeenLastCalledWith(Ipc.galleryCopyImage, { path: second.path })
  act(() => key('ArrowLeft'))
  await act(async () => button('另存为…').click())
  expect(invoke).toHaveBeenLastCalledWith(Ipc.gallerySaveAs, { path: first.path })
  act(() => key('Escape'))
  act(() => key('c', true))
  expect(invoke).toHaveBeenCalledTimes(3)
})
it.each([
  'https://example.org/image.png',
  '//server/share/image.png',
  '\\\\server\\share\\photo.png',
  'file:///tmp/sample.jpg',
  'data:text/html;base64,AAAA',
  'data:image/svg+xml;base64,AAAA',
])('never opens an external or unsupported source: %s', (path) => {
  act(() => openImagePreview({ path }))
  expect(document.querySelector('dialog')).toBeNull()
  expect(invoke).not.toHaveBeenCalled()
})
it('pans enlarged pixels only during a captured drag, without closing the picture', () => {
  open()
  const img = image(),
    stage = document.querySelector<HTMLElement>('[data-preview-stage]')!
  img.setPointerCapture = vi.fn()
  const scroll = vi.spyOn(stage, 'scrollTo')
  stage.scrollLeft = 10
  stage.scrollTop = 40
  const point = (type: string, x: number, y: number): void => {
    img.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: y }))
  }
  act(() => {
    point('pointerdown', 100, 150)
    point('pointermove', 50, 100)
  })
  expect(scroll).not.toHaveBeenCalled()
  act(() => button('放大').click())
  act(() => {
    point('pointerdown', 100, 150)
    point('pointermove', 50, 100)
    point('lostpointercapture', 50, 100)
    point('pointermove', 0, 0)
  })
  expect(scroll.mock.calls).toEqual([[60, 90]])
  expect(image()).toBe(img)
})
it('does not report success or expose a filesystem path when native copy fails', async () => {
  invoke.mockRejectedValueOnce(new Error('EPERM /secret/album/file.png'))
  open()
  await act(async () => key('c', true))
  const text = document.querySelector('dialog')!.textContent
  expect(text).not.toContain('/secret')
  expect(text).not.toContain('已复制图片')
  expect(text).toContain('失败')
})
it('does not echo directory names if a caller supplied a path as the file name', () => {
  act(() => openImagePreview({ path: '/private/work/first.png', name: '/private/work/first.png' }))
  expect(image().alt).toBe('first.png')
  expect(document.querySelector('dialog')?.textContent).not.toContain('/private')
})
it.each(['猫/狗', 'a cat / a dog，第500步'])('shows a title that is not a file path in full: %s', (title) => {
  act(() => openImagePreview({ path: '/pictures/first.png', title, name: 'first.png' }))
  expect(image().alt).toBe(title)
  expect(document.querySelector('dialog h2')?.textContent).toBe(title)
})
it('keeps the reason main gives when native copy fails', async () => {
  refuse('E_NOT_FOUND', '找不到这张图片，可能已被移动或删除')
  open()
  await act(async () => key('c', true))
  expect(document.querySelector('dialog')?.textContent).toContain('找不到这张图片，可能已被移动或删除')
})
it('copies the shown pixels as PNG when main cannot read the format, and keeps its reason if they are not shown yet', async () => {
  const reason = '这张图片的格式不能复制，可以用「另存为…」保存后再用'
  refuse('E_IMAGE_FORMAT', reason)
  open()
  await act(async () => key('c', true))
  expect(document.querySelector('dialog')?.textContent).toContain(reason)
  refuse('E_IMAGE_FORMAT', reason)
  const { context, write } = decoded()
  await act(async () => button('复制图片').click())
  expect(context.drawImage).toHaveBeenCalledWith(image(), 0, 0)
  expect(write).toHaveBeenCalledOnce()
  expect(document.querySelector('dialog')?.textContent).toContain('已复制图片')
})
it('shows and copies a grayscale picture in grayscale, not the colour file', async () => {
  act(() => openImagePreview({ ...first, grayscale: true }))
  expect(image().classList).toContain('grayscale')
  const { context, write } = decoded()
  await act(async () => key('c', true))
  expect(invoke).not.toHaveBeenCalled()
  expect(context.filter).toBe('grayscale(1)')
  expect(write).toHaveBeenCalledOnce()
})
it('zooms in proportion to the wheel distance and keeps the wheel from scrolling the picture', () => {
  open()
  act(() => button('100%').click())
  const wheel = (deltaY: number): WheelEvent => {
    const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })
    act(() => {
      image().dispatchEvent(event)
    })
    return event
  }
  expect(wheel(-4).defaultPrevented).toBe(true)
  expect(parseFloat(image().style.width)).toBeCloseTo(202, 0)
  act(() => button('100%').click())
  wheel(-5000)
  expect(parseFloat(image().style.width)).toBeCloseTo(256.8, 0)
})
it('lets the dialog animate out with the picture it showed, without taking keys meanwhile', async () => {
  await act(async () => {
    document.documentElement.dataset.uiAnimation = 'on'
  })
  open()
  act(() => key('Escape'))
  expect(document.querySelector('dialog')?.dataset.motionState).toBe('closed')
  expect(image().src).toBe('clover://local?path=%2Fpictures%2Ffirst.png')
  await act(async () => key('c', true))
  expect(invoke).not.toHaveBeenCalled()
  await act(() => new Promise((resolve) => setTimeout(resolve, 400)))
  expect(document.querySelector('dialog')).toBeNull()
})
it('does not send a data preview to gallery IPC or offer file export', async () => {
  act(() => openImagePreview({ path: 'data:image/png;base64,AAAA' }))
  expect(image().src).toBe('data:image/png;base64,AAAA')
  expect(button('另存为…')).toBeUndefined()
  await act(async () => key('c', true))
  expect(invoke).not.toHaveBeenCalled()
  expect(document.querySelector('dialog')?.textContent).not.toContain('已复制图片')
})
