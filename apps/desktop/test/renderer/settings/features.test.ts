import { describe, expect, it } from 'vitest'
import { FEATURES, featureEnabled, featureVisibility } from '@renderer/lib/features'
import { settingsFixture } from '@test/mocks/backend/fixtures'

const ALL_OFF = { remoteHosts: false, workerHosts: false, training: false, gbc: false, lan: false, externalAgents: false }

describe('optional features', () => {
  it('lists remote hosts, Worker hosts, training, 看图拆区域, LAN access and external Agents with an explanation each', () => {
    expect(FEATURES.map((feature) => feature.key)).toEqual([
      'remoteHostsEnabled',
      'workerHostsEnabled',
      'trainingEnabled',
      'gbcEnabled',
      'lanWebEnabled',
      'externalAgentsEnabled',
    ])
    for (const feature of FEATURES) expect(feature.description.length).toBeGreaterThan(8)
  })

  it('hides everything until settings load', () => {
    expect(featureVisibility(null)).toEqual(ALL_OFF)
    expect(featureEnabled(undefined, 'trainingEnabled')).toBe(false)
  })

  it('follows the switches', () => {
    const settings = settingsFixture({ remoteHostsEnabled: true, trainingEnabled: false, lanWebEnabled: true })
    expect(featureVisibility(settings)).toEqual({ ...ALL_OFF, remoteHosts: true, lan: true })
    expect(featureVisibility(settingsFixture({ externalAgentsEnabled: true }))).toEqual({ ...ALL_OFF, externalAgents: true })
  })

  it('keeps Worker hosts off while 远程主机 is off, even with their own switch on', () => {
    expect(featureEnabled(settingsFixture({ workerHostsEnabled: true }), 'workerHostsEnabled')).toBe(false)
    expect(featureEnabled(settingsFixture({ remoteHostsEnabled: true, workerHostsEnabled: true }), 'workerHostsEnabled')).toBe(true)
    expect(FEATURES.find((feature) => feature.key === 'workerHostsEnabled')?.within).toBe('remoteHostsEnabled')
  })
})
