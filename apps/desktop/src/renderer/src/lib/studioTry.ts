/**
 * 训练 → Studio handoff for 在创作中试用: the Studio adds a 风格 holding the
 * saved LoRA and a new 画面 wired to it (`tryLoraOnBoard` in
 * pages/studio/nodes.ts) to the project that is open.
 *
 * The 训练 page puts one of these in the store (`requestStudioTry`) and
 * navigates to /studio; Studio takes it once with `takeStudioTryRequest()`.
 */
export interface StudioTryRequest {
  /** Unique per request, so a consumer can ignore one it already applied. */
  id: string
  /** The LoRA's id in the 模型 library (`TrainingProject.adapterId`). */
  adapterId: string
  /** The training's name; the 风格 is named after it. */
  name: string
  /** The 画面's description: the first sample prompt, which carries the trigger word. */
  prompt: string
}

/** Defensive check for consumers: true only for a well-formed request. */
export function isStudioTryRequest(value: unknown): value is StudioTryRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Record<string, unknown>
  return (
    typeof request['id'] === 'string' &&
    Boolean(request['id']) &&
    typeof request['adapterId'] === 'string' &&
    Boolean(request['adapterId']) &&
    typeof request['name'] === 'string' &&
    typeof request['prompt'] === 'string'
  )
}
