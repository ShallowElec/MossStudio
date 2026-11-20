import { existsSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { expandPathVariables, isNetworkPath, linksToNetwork, missingPlace } from '@main/lib/localPath'
import { useTempDir } from '@test/helpers/tempDir'

const temp = useTempDir('mossstudio-local-path-')

describe('expandPathVariables', () => {
  afterEach(() => {
    delete process.env.MOSS_TEST_SECRET
  })

  it('expands ~ and the home variable', () => {
    expect(expandPathVariables('~/models')).toBe(homedir() + '/models')
    expect(expandPathVariables('$HOME/models')).toBe(homedir() + '/models')
    expect(expandPathVariables('${HOME}/models')).toBe(homedir() + '/models')
  })

  it('leaves any other variable as written, whatever its form', () => {
    process.env.MOSS_TEST_SECRET = 'token'
    for (const path of ['${MOSS_TEST_SECRET}/x', '$MOSS_TEST_SECRET/x', '%MOSS_TEST_SECRET%\\x', '\\\\h@SSL\\%MOSS_TEST_SECRET%']) {
      expect(expandPathVariables(path)).toBe(path)
    }
  })
})

describe('isNetworkPath', () => {
  it('treats UNC, WebDAV, device paths and URLs as network places', () => {
    for (const path of [
      '\\\\server\\share\\models',
      '\\\\attacker@SSL\\share',
      '\\\\?\\UNC\\server\\share',
      '\\??\\UNC\\server\\share',
      '\\\\.\\pipe\\x',
      '//server/share',
      'https://host/models',
      'file://host/share',
    ]) {
      expect(isNetworkPath(path)).toBe(true)
    }
  })

  it('accepts drive and POSIX paths', () => {
    for (const path of ['C:\\ComfyUI\\models', 'D:/weights', '/home/me/models', 'models/checkpoints']) {
      expect(isNetworkPath(path)).toBe(false)
    }
  })
})

describe('linksToNetwork', () => {
  it('reads where a link points without following it', async () => {
    await mkdir(join(temp(), 'weights'))
    await symlink('//attacker/share', join(temp(), 'remote'))
    await symlink(join(temp(), 'weights'), join(temp(), 'local'))
    expect(await linksToNetwork(join(temp(), 'remote'))).toBe(true)
    expect(await linksToNetwork(join(temp(), 'local'))).toBe(false)
    expect(await linksToNetwork(join(temp(), 'weights'))).toBe(false)
  })
})

describe('missingPlace', () => {
  it('says the file is gone when its folder is still there, or when only a folder inside the disk is gone', async () => {
    expect(await missingPlace(join(temp(), 'moss_image_sft_int8.safetensors'))).toBe('file')
    expect(await missingPlace(join(temp(), 'moved', 'models', 'moss_image_sft_int8.safetensors'))).toBe('file')
  })

  it('says the disk is missing when its mount folder or drive letter is gone', async () => {
    const mountParent = ['/mnt', '/Volumes', '/media'].find((folder) => existsSync(folder))
    const drive = 'QRSTUVWXYZ'.split('').find((letter) => !existsSync(`${letter}:\\`))
    const path =
      process.platform === 'win32'
        ? `${drive}:\\Models\\moss.safetensors`
        : `${mountParent}/mossstudio-unplugged-disk/models/moss.safetensors`
    expect(await missingPlace(path)).toBe('drive')
  })

  it('never reads a network path', async () => {
    expect(await missingPlace('\\\\nas\\models\\moss.safetensors')).toBe('file')
  })
})
