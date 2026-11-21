import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { paths } from '@main/lib/paths'
import { useTempDataRoot } from '@test/helpers/tempDir'
import {
  cachedSafetensorsTriggers,
  extractSafetensorsTriggers,
  saveLoraProfile,
  mergeLoraMeta,
  listLoraProfiles,
} from '@main/services/loraProfiles'

useTempDataRoot()
it.each(['{broken', '{}', '[{"loraId":4}]'])('reads no profile from a damaged file: %s', async (contents) => {
  await mkdir(paths.root(), { recursive: true })
  await writeFile(paths.loraProfiles(), contents)
  await expect(listLoraProfiles()).resolves.toEqual([])
  await expect(mergeLoraMeta({ id: 'style' })).resolves.toEqual({ id: 'style' })
})
it('extracts only bounded header metadata, ranks suggestions and honors saved overrides', async () => {
  await mkdir(paths.root(), { recursive: true })
  const file = join(paths.root(), 'style.safetensors')
  const header = Buffer.from(
    JSON.stringify({
      __metadata__: { 'modelspec.trigger_word': 'header, exact', ss_tag_frequency: JSON.stringify({ a: { suggested: 10, other: 2 } }) },
    }),
  )
  const length = Buffer.alloc(8)
  length.writeBigUInt64LE(BigInt(header.length))
  await writeFile(file, Buffer.concat([length, header]))
  await writeFile(file.replace('.safetensors', '.txt'), 'sidecar')
  expect(await extractSafetensorsTriggers(file)).toEqual({ triggers: ['header', 'exact'], suggestedTriggers: ['suggested', 'other'] })
  await Promise.all([
    saveLoraProfile({ loraId: 'style', triggers: ['manual'], autoInsert: 'prefix' }),
    saveLoraProfile({ loraId: 'other', triggers: [] }),
  ])
  expect(await listLoraProfiles()).toHaveLength(2)
  expect(await mergeLoraMeta({ id: 'style' }, file)).toMatchObject({
    triggers: ['manual'],
    autoInsert: 'prefix',
    suggestedTriggers: ['suggested', 'other'],
  })
})
it('rejects oversized or truncated headers without reading weights', async () => {
  await mkdir(paths.root(), { recursive: true })
  const file = join(paths.root(), 'bad.safetensors')
  const length = Buffer.alloc(8)
  length.writeBigUInt64LE(16n * 1024n * 1024n + 1n)
  await writeFile(file, length)
  await expect(extractSafetensorsTriggers(file)).rejects.toThrow()
  length.writeBigUInt64LE(100n)
  await writeFile(file, length)
  await expect(extractSafetensorsTriggers(file)).rejects.toThrow()
})
it('uses sidecars in priority order when the header has no triggers', async () => {
  await mkdir(paths.root(), { recursive: true })
  const file = join(paths.root(), 'side.safetensors')
  const header = Buffer.from('{}')
  const length = Buffer.alloc(8)
  length.writeBigUInt64LE(BigInt(header.length))
  await writeFile(file, Buffer.concat([length, header]))
  await writeFile(file.replace('.safetensors', '.civitai.info'), JSON.stringify({ trainedWords: ['Civitai'] }))
  await writeFile(file.replace('.safetensors', '.json'), JSON.stringify({ triggers: ['json'] }))
  expect((await extractSafetensorsTriggers(file)).triggers).toEqual(['Civitai'])
})

it('keeps the good rows when one row is bad, and backs the file up before the next save replaces it', async () => {
  await mkdir(paths.root(), { recursive: true })
  const original = JSON.stringify([{ loraId: 'kept', triggers: ['ink'] }, { loraId: 4 }, { loraId: 'also', autoInsert: 'prefix' }])
  await writeFile(paths.loraProfiles(), original)
  expect((await listLoraProfiles()).map((row) => row.loraId)).toEqual(['kept', 'also'])
  await saveLoraProfile({ loraId: 'new', triggers: ['sks'] })
  expect((await listLoraProfiles()).map((row) => row.loraId)).toEqual(['kept', 'also', 'new'])
  const backups = (await readdir(paths.root())).filter((name) => name.startsWith('lora-profiles.json.damaged-'))
  expect(backups).toHaveLength(1)
  expect(await readFile(join(paths.root(), backups[0]!), 'utf8')).toBe(original)
})

it('never loses saved profiles to a file that is not JSON: it is kept aside first', async () => {
  await mkdir(paths.root(), { recursive: true })
  await writeFile(paths.loraProfiles(), '[{"loraId":"kept"')
  await saveLoraProfile({ loraId: 'new' })
  const backups = (await readdir(paths.root())).filter((name) => name.startsWith('lora-profiles.json.damaged-'))
  expect(await readFile(join(paths.root(), backups[0]!), 'utf8')).toBe('[{"loraId":"kept"')
})

it('reads a LoRA file once per version, and never opens a network path', async () => {
  await mkdir(paths.root(), { recursive: true })
  const file = join(paths.root(), 'cached.safetensors')
  const write = async (word: string) => {
    const header = Buffer.from(JSON.stringify({ __metadata__: { trigger_word: word } }))
    const length = Buffer.alloc(8)
    length.writeBigUInt64LE(BigInt(header.length))
    await writeFile(file, Buffer.concat([length, header]))
  }
  await write('one')
  expect((await cachedSafetensorsTriggers(file)).triggers).toEqual(['one'])
  await write('twoo')
  await utimes(file, new Date(), new Date(Date.now() + 5000))
  expect((await cachedSafetensorsTriggers(file)).triggers).toEqual(['twoo'])
  expect(await cachedSafetensorsTriggers('\\\\server\\share\\style.safetensors')).toEqual({})
  expect(await cachedSafetensorsTriggers('//server/share/style.safetensors')).toEqual({})
})

it('reads no profiles from a file that cannot be read, instead of failing the model list', async () => {
  await mkdir(paths.loraProfiles(), { recursive: true })
  await expect(listLoraProfiles()).resolves.toEqual([])
  await expect(mergeLoraMeta({ id: 'style' })).resolves.toEqual({ id: 'style' })
})
