import { describe, expect, it } from 'vitest'
import { MIN_TRAINING_VRAM_BYTES } from '@shared/training'
import { judgeMachine, parseGpuRows } from '@main/services/training/readiness'

const GIB = 1024 ** 3
const gpu = (gib: number) => ({ name: 'NVIDIA GeForce RTX', memoryBytes: gib * GIB })

describe('training readiness verdict', () => {
  it('blocks a Mac, a computer without an NVIDIA card, and a card below the minimum', () => {
    expect(judgeMachine({ mac: true, gpu: null, ramBytes: 16 * GIB }).blockReason).toBe('mac')
    expect(judgeMachine({ mac: false, gpu: null, ramBytes: 16 * GIB }).blockReason).toBe('no-nvidia')
    expect(judgeMachine({ mac: false, gpu: { name: 'x', memoryBytes: MIN_TRAINING_VRAM_BYTES - 1 }, ramBytes: null }).blockReason).toBe(
      'low-vram',
    )
    const ok = judgeMachine({ mac: false, gpu: { name: 'x', memoryBytes: MIN_TRAINING_VRAM_BYTES }, ramBytes: null })
    expect(ok).toMatchObject({ blockReason: null, gpuOk: true })
  })

  it('warns about RAM only for cards under 16 GB on computers under 32 GB', () => {
    expect(judgeMachine({ mac: false, gpu: gpu(12), ramBytes: 16 * GIB }).ramLow).toBe(true)
    expect(judgeMachine({ mac: false, gpu: gpu(12), ramBytes: 32 * GIB }).ramLow).toBe(false)
    expect(judgeMachine({ mac: false, gpu: gpu(16), ramBytes: 16 * GIB }).ramLow).toBe(false)
  })

  it('turns samples on by default only above 8 GB', () => {
    expect(judgeMachine({ mac: false, gpu: gpu(8), ramBytes: null }).samplesByDefault).toBe(false)
    expect(judgeMachine({ mac: false, gpu: gpu(12), ramBytes: null }).samplesByDefault).toBe(true)
  })

  it('reads nvidia-smi rows largest card first, with or without units', () => {
    expect(parseGpuRows('NVIDIA GeForce RTX 3060, 12288 MiB\nNVIDIA GeForce RTX 4090, 24564\n\n')).toEqual([
      { name: 'NVIDIA GeForce RTX 4090', memoryBytes: 24564 * 1024 * 1024 },
      { name: 'NVIDIA GeForce RTX 3060', memoryBytes: 12288 * 1024 * 1024 },
    ])
    expect(parseGpuRows('')).toEqual([])
  })
})
