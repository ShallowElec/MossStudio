import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Catalog, ModelEntry } from '@shared/types'
import { ENGINE_CHECKED } from '@shared/modelCombos'
import type { ModelLocation } from '@renderer/pages/models/useModelLocation'
import { catalogFixture } from '../../mocks/backend'
import { loadStore } from '../../helpers/renderer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.setConfig({ testTimeout: 30_000 })

beforeAll(async () => {
  await import('@renderer/components/ui')
  await import('@renderer/pages/models/CombinationDialog')
}, 60_000)

let root: Root | null = null
let container: HTMLElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

function localLocation(): ModelLocation {
  return {
    kind: 'local',
    workerDaemon: false,
    host: null,
    ready: true,
    tasks: [],
    inventory: null,
    scanning: false,
    scanError: null,
    isModelInstalled: (model) => model.installed,
    isAdapterInstalled: (adapter) => adapter.installed,
    download: async () => undefined,
    downloadBundle: async () => undefined,
    pause: async () => undefined,
    resume: async () => undefined,
    cancel: async () => undefined,
    remove: async () => undefined,
    removeMany: async () => undefined,
    rescan: () => undefined,
  }
}

describe('CombinationDialog', () => {
  it('resolves a shared initial slot to its deduplicated local-import twin so the select stays valid', async () => {
    await loadStore('ready')
    const { ToastProvider } = await import('@renderer/components/ui')
    const { CombinationDialog } = await import('@renderer/pages/models/CombinationDialog')

    const base = catalogFixture({ installed: ['qwen35-comfy-int8_convrot', 'flux2-vae-comfy-small', 'moss-runtime-config'] })
    const registeredTwin: ModelEntry = {
      id: 'local-scan-dit',
      name: 'moss_image_sft_int8.safetensors',
      provider: 'local',
      repo: 'F:\\ComfyUI\\models\\diffusion_models\\moss_image_sft_int8.safetensors',
      revision: 'local',
      role: 'dit',
      format: 'comfyui',
      precision: 'int8',
      license: 'local',
      tags: ['local-import', ENGINE_CHECKED],
      localPath: 'F:\\ComfyUI\\models\\diffusion_models\\moss_image_sft_int8.safetensors',
      installed: true,
      installedBytes: 5_413_698_958,
      sizeBytes: 5_413_698_958,
    }
    const sharedTwin: ModelEntry = {
      ...registeredTwin,
      id: 'shared-abc123',
      repo: 'f:\\ComfyUI\\models\\diffusion_models\\moss_image_sft_int8.safetensors',
      localPath: 'f:\\ComfyUI\\models\\diffusion_models\\moss_image_sft_int8.safetensors',
      tags: ['shared-directory'],
    }
    const catalog: Catalog = { ...base, models: [...base.models, registeredTwin, sharedTwin] }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        createElement(
          ToastProvider,
          null,
          createElement(CombinationDialog, {
            open: true,
            catalog,
            location: localLocation(),
            initial: { dit: sharedTwin.id },
            onClose: () => undefined,
          }),
        ),
      )
    })

    const ditSelect = document.querySelector<HTMLSelectElement>('#combination-dit')
    expect(ditSelect).not.toBeNull()
    expect(ditSelect!.value).toBe(registeredTwin.id)
    expect([...ditSelect!.options].some((option) => option.value === registeredTwin.id)).toBe(true)
  })
})
