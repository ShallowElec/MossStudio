/**
 * 自动描述: one short Chinese sentence per picture from the 语言模型 chosen for 助手和漫画 in
 * 设置 › 语言模型. Pictures leave the computer only through this action, which the person starts.
 */
import { readFile } from 'node:fs/promises'
import { nativeImage } from 'electron'
import type { TrainingCaptionResult, TrainingKind } from '@shared/training'
import { errorCode } from '../../lib/codedError'
import { readImageHeader } from '../imageHeaders'
import { languageProvider } from '@shared/ai'
import { askAboutImage, E_NO_IMAGE_INPUT, listProviders } from '../ai'
import { getSettings } from '../settings'
import { scanDataset, writeCaptions } from './dataset'
import { getTrainingProject } from './store'

const CAPTION_TIMEOUT_MS = 60_000
const CONCURRENCY = 3
/** Larger pictures are sent as a smaller JPEG: providers cap a picture at a few MB. */
const MAX_SEND_BYTES = 3.5 * 1024 * 1024
const SEND_SIDE = 1536

export const NO_PROVIDER = '还没有连接语言模型。连接一个能看图的，再自动写描述。'
export const NO_IMAGE_INPUT = '「助手和漫画」用的语言模型看不了图片。在 设置 › 语言模型 里换一个能看图的，再试一次。'
export const ALL_FAILED = '描述没有写成。请确认语言模型能连上，稍后再试。'

const SYSTEM = '你为图像模型的训练图片写描述。只输出一句简短的中文描述，不加引号、编号或解释。'

/** What to ask for: the subject by its trigger word, never its fixed look; for 画风, the content only. */
export function captionPrompt(kind: TrainingKind, trigger: string): string {
  if (kind === 'style') {
    return '描述这张图片画了什么：主体、动作、场景、光线和取景。不要描述画风、笔触、色调或艺术风格。'
  }
  const subject = kind === 'person' ? '这个人' : '这个物品'
  return [
    `用「${trigger}」指代图中的${subject}，句子以「${trigger}」开头。`,
    kind === 'person' ? '描述姿势、表情、衣着、场景、光线和取景（特写、半身或全身）。' : '描述摆放方式、角度、场景、光线和取景。',
    `不要描述${subject}本身固定的样子（${kind === 'person' ? '长相、脸型、发色、体型' : '形状、颜色、材质、花纹'}）。`,
  ].join('')
}

/** The model's answer as a caption: one line, no wrapping quotes, the trigger first for 人物/物品. */
export function cleanCaption(answer: string, kind: TrainingKind, trigger: string): string {
  let text = answer
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '')
    .trim()
  if (kind !== 'style' && trigger && !text.startsWith(trigger)) text = `${trigger}，${text}`
  return text
}

async function pictureForSending(path: string): Promise<{ data: Uint8Array; mime: string }> {
  const data = await readFile(path)
  const format = readImageHeader(data)?.format ?? 'png'
  if (data.length > MAX_SEND_BYTES) {
    const image = nativeImage.createFromPath(path)
    if (!image.isEmpty()) {
      const { width, height } = image.getSize()
      const scaled =
        width >= height ? image.resize({ width: Math.min(width, SEND_SIDE) }) : image.resize({ height: Math.min(height, SEND_SIDE) })
      return { data: scaled.toJPEG(85), mime: 'image/jpeg' }
    }
  }
  return { data, mime: format === 'jpeg' ? 'image/jpeg' : `image/${format}` }
}

export async function autoCaption(id: string, names?: string[]): Promise<TrainingCaptionResult> {
  const project = await getTrainingProject(id)
  const providerId = languageProvider(listProviders(), getSettings().languageProviderId)?.id
  if (!providerId) return { written: 0, failed: 0, error: NO_PROVIDER }
  const dataset = await scanDataset(id)
  const wanted = names ? new Set(names) : null
  const targets = dataset.images.filter((image) => (wanted ? wanted.has(image.name) : !image.caption))
  if (!targets.length) return { written: 0, failed: 0, error: null }

  const prompt = captionPrompt(project.kind, project.trigger)
  const written = new Map<string, string>()
  let failed = 0
  let noImageInput = false
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < targets.length && !noImageInput) {
      const image = targets[next++]!
      try {
        const answer = await askAboutImage(
          providerId,
          { system: SYSTEM, prompt, image: await pictureForSending(image.path) },
          CAPTION_TIMEOUT_MS,
        )
        const caption = cleanCaption(answer, project.kind, project.trigger)
        if (caption && caption !== project.trigger) written.set(image.name, caption)
        else failed += 1
      } catch (error) {
        if (errorCode(error) === E_NO_IMAGE_INPUT) noImageInput = true
        else {
          failed += 1
          console.warn('[training]', `caption for ${image.name} failed:`, error instanceof Error ? error.message : error)
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker))
  await writeCaptions(id, written)
  if (noImageInput && !written.size) return { written: 0, failed: 0, error: NO_IMAGE_INPUT }
  const skipped = noImageInput ? targets.length - written.size - failed : 0
  return { written: written.size, failed: failed + skipped, error: written.size === 0 && failed > 0 ? ALL_FAILED : null }
}
