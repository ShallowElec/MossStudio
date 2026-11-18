import { describe, expect, it } from 'vitest'
import { torchBuildCurrent, torchIndexes, torchRequirements, versionUnavailable } from '@main/services/trainers'

const WHL = 'https://download.pytorch.org/whl'
const CU130 = `${WHL}/cu130`
const CU128 = `${WHL}/cu128`
const CU126 = `${WHL}/cu126`
const CPU = `${WHL}/cpu`
const auto = { torchIndex: null, torchBackend: 'auto' as const }

describe('main/services/trainers PyTorch build', () => {
  it("installs the trainer's own torch requirements first, plain torch when it names none", () => {
    expect(torchRequirements(['torch>=2.13,<2.15', 'torchvision', 'diffusers[torch]>=0.38', 'safetensors'])).toEqual([
      'torch>=2.13,<2.15',
      'torchvision',
    ])
    expect(torchRequirements(['torchaudio==2.9.0', 'peft'])).toEqual(['torchaudio==2.9.0'])
    expect(torchRequirements(['diffusers>=0.38'])).toEqual(['torch'])
  })

  it('needs an index of its own only on Windows: PyPI already has the CUDA wheel on Linux and MPS on macOS', () => {
    const driver = { present: true, major: 581 }
    expect(torchIndexes(auto, driver, 'linux')).toEqual([])
    expect(torchIndexes(auto, { present: false, major: null }, 'darwin')).toEqual([])
    // Every CUDA index the driver runs, newest first: they carry different PyTorch versions (cu128 stops at 2.11).
    expect(torchIndexes(auto, driver, 'win32')).toEqual([CU130, CU128, CU126])
    expect(torchIndexes(auto, { present: true, major: 572 }, 'win32')).toEqual([CU128, CU126])
    // A driver too old for every index gets the oldest build; one of unknown age, the oldest first.
    expect(torchIndexes(auto, { present: true, major: 551 }, 'win32')).toEqual([CU126])
    expect(torchIndexes(auto, { present: true, major: null }, 'win32')).toEqual([CU126, CU128, CU130])
    // No NVIDIA card: PyPI's CPU wheel is what there is.
    expect(torchIndexes(auto, { present: false, major: null }, 'win32')).toEqual([])
  })

  it('follows 设置: a PyTorch source of its own, CPU, or CUDA anywhere but a Mac', () => {
    const driver = { present: true, major: 581 }
    expect(torchIndexes({ torchIndex: 'https://mirror.example/whl/cu130/', torchBackend: 'auto' }, driver, 'linux')).toEqual([
      'https://mirror.example/whl/cu130',
    ])
    expect(torchIndexes({ torchIndex: null, torchBackend: 'cpu' }, driver, 'win32')).toEqual([CPU])
    expect(torchIndexes({ torchIndex: null, torchBackend: 'cuda' }, driver, 'linux')).toEqual([CU130, CU128, CU126])
    expect(torchIndexes({ torchIndex: null, torchBackend: 'cuda' }, driver, 'darwin')).toEqual([])
  })

  it('keeps an environment whose PyTorch came from one of the wanted sources', () => {
    expect(torchBuildCurrent(CU126, [CU130, CU128, CU126], 'win32')).toBe(true)
    expect(torchBuildCurrent(CPU, [CU130, CU128, CU126], 'win32')).toBe(false)
    expect(torchBuildCurrent(null, [], 'linux')).toBe(true)
    // A CUDA build also runs on the CPU: never worth a download when nothing particular is wanted.
    expect(torchBuildCurrent(CU130, [], 'win32')).toBe(true)
    expect(torchBuildCurrent(CPU, [], 'linux')).toBe(false)
  })

  it('reinstalls an older Windows environment on an NVIDIA machine, never one elsewhere or when it cannot tell', () => {
    // Made before the source was recorded: plain PyPI, the CPU build on Windows.
    expect(torchBuildCurrent(undefined, [CU130, CU128, CU126], 'win32')).toBe(false)
    expect(torchBuildCurrent(undefined, [], 'win32')).toBe(true)
    expect(torchBuildCurrent(undefined, [], 'linux')).toBe(true)
    // nvidia-smi did not answer: nothing is reinstalled.
    expect(torchBuildCurrent(undefined, undefined, 'win32')).toBe(true)
  })

  it('moves on to the next index only when this one lacks the version, not when the index cannot be reached', () => {
    expect(
      versionUnavailable(
        'ERROR: Could not find a version that satisfies the requirement torch<2.15,>=2.13 (from versions: 2.9.0+cu128, 2.11.0+cu128)\nERROR: No matching distribution found for torch<2.15,>=2.13',
      ),
    ).toBe(true)
    expect(versionUnavailable('  × No solution found when resolving dependencies:\n  ╰─▶ Because only torch<=2.11.0 is available')).toBe(
      true,
    )
    expect(versionUnavailable('ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device')).toBe(false)
    // pip's words when the index did not answer at all.
    expect(
      versionUnavailable(
        'ERROR: Could not find a version that satisfies the requirement torch (from versions: none)\nERROR: No matching distribution found for torch',
      ),
    ).toBe(false)
  })
})
