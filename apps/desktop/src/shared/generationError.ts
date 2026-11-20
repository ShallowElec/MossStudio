/**
 * A failed generation in plain words. The engine says what went wrong in its
 * own (English) text; the code it returns is what the app knows how to word.
 * The engine's text stays in the job log, behind 查看详情.
 */

/** The engine ran out of GPU memory: `out_of_memory` from moss-server, a memory error from the CLI engines. */
export const OUT_OF_MEMORY = 'E_OOM'

/** The words a card, 活动 and the notification show for a failed generation. */
export function generationErrorText(error: { code: string; message: string }): string {
  if (error.code === OUT_OF_MEMORY) return '显存不够这个尺寸'
  return error.message
}

/** A smaller picture gets through where the same one would fail again. */
export function smallerPictureHelps(error: { code: string } | undefined): boolean {
  return error?.code === OUT_OF_MEMORY
}
