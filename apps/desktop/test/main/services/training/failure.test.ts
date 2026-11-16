import { describe, expect, it } from 'vitest'
import { GENERIC_FAILURE, trainingFailureReason } from '@main/services/training/failure'

describe('training failure reasons', () => {
  it('names running out of video memory, even when a missing-file line follows in the traceback', () => {
    const reason = trainingFailureReason([
      'step 120 loss=0.12',
      'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB',
      'FileNotFoundError: [Errno 2] No such file or directory: runs/x/tmp',
    ])
    expect(reason).toContain('显存不够')
  })

  it('tells missing files, a full disk, a broken environment and a lost host apart', () => {
    expect(trainingFailureReason(['FileNotFoundError: weights/diffusion_models/x.safetensors'])).toContain('文件找不到')
    expect(trainingFailureReason(['OSError: [Errno 28] No space left on device'])).toContain('磁盘空间不够')
    expect(trainingFailureReason(["ModuleNotFoundError: No module named 'kohakumoss'"])).toContain('训练环境不完整')
    expect(trainingFailureReason(['Connection reset by 10.0.0.2 port 22'])).toContain('连接断了')
  })

  it('falls back to a general sentence for anything else', () => {
    expect(trainingFailureReason(['Traceback (most recent call last):', 'ValueError: bad knob'])).toBe(GENERIC_FAILURE)
    expect(trainingFailureReason([])).toBe(GENERIC_FAILURE)
  })
})
