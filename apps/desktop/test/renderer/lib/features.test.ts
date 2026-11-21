import { describe, expect, it } from 'vitest'
import { FEATURES, featureEnabled, featureVisibility } from '@renderer/lib/features'
import { settingsFixture } from '../../mocks/backend'

const ALL_OFF = { remoteHosts: false, workerHosts: false, training: false, gbc: false, lan: false, externalAgents: false }

describe('lib/features', () => {
  it('lists each optional feature once with copy', () => {
    expect(FEATURES.map((feature) => feature.key)).toEqual([
      'remoteHostsEnabled',
      'workerHostsEnabled',
      'trainingEnabled',
      'gbcEnabled',
      'lanWebEnabled',
      'externalAgentsEnabled',
    ])
    expect(FEATURES.every((feature) => feature.label && feature.description)).toBe(true)
  })

  it('every optional feature is off in default settings', () => {
    expect(featureVisibility(settingsFixture())).toEqual(ALL_OFF)
  })

  it('reads each toggle independently', () => {
    expect(featureVisibility(settingsFixture({ trainingEnabled: true }))).toEqual({ ...ALL_OFF, training: true })
    expect(featureVisibility(settingsFixture({ remoteHostsEnabled: true, lanWebEnabled: true }))).toEqual({
      ...ALL_OFF,
      remoteHosts: true,
      lan: true,
    })
  })

  it('reads 看图拆区域 on its own', () => {
    expect(featureVisibility(settingsFixture({ gbcEnabled: true }))).toEqual({ ...ALL_OFF, gbc: true })
  })

  it('treats missing settings as everything off', () => {
    expect(featureEnabled(null, 'trainingEnabled')).toBe(false)
    expect(featureEnabled(undefined, 'lanWebEnabled')).toBe(false)
    expect(featureVisibility(null)).toEqual(ALL_OFF)
  })
})
