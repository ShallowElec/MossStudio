import { describe, expect, it } from 'vitest'
import {
  SETTINGS_SECTIONS,
  isCanonicalSectionPath,
  sectionFromPath,
  sectionLabel,
  sectionPath,
  visibleSections,
} from '@renderer/pages/settings/sections'

describe('settings sections', () => {
  it('lists the eight sections in order, 训练 after 功能', () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([
      'general',
      'devices',
      'storage',
      'network',
      'features',
      'training',
      'updates',
      'about',
    ])
  })

  it('lists 训练 only while training is turned on', () => {
    expect(visibleSections({ trainingEnabled: false }).map((section) => section.id)).not.toContain('training')
    expect(visibleSections(null).map((section) => section.id)).not.toContain('training')
    expect(visibleSections({ trainingEnabled: true }).map((section) => section.id)).toContain('training')
  })

  it('reads the section from the URL', () => {
    expect(sectionFromPath('/settings/network')).toBe('network')
    expect(sectionFromPath('/settings/Devices')).toBe('devices')
    expect(sectionFromPath('/settings/devices/extra')).toBe('devices')
    expect(sectionFromPath('/settings/training')).toBe('training')
  })

  it('opens 通用 for bare, unknown and foreign paths', () => {
    expect(sectionFromPath('/settings')).toBe('general')
    expect(sectionFromPath('/settings/nope')).toBe('general')
    expect(sectionFromPath('/studio')).toBe('general')
  })

  it('maps old section names to their new home', () => {
    expect(sectionFromPath('/settings/lan')).toBe('features')
    expect(sectionFromPath('/settings/engines')).toBe('devices')
    expect(sectionFromPath('/settings/diagnostics')).toBe('about')
    expect(sectionFromPath('/settings/alerts')).toBe('updates')
  })

  it('builds canonical paths', () => {
    expect(sectionPath('features')).toBe('/settings/features')
    expect(isCanonicalSectionPath('/settings/features')).toBe(true)
    expect(isCanonicalSectionPath('/settings/lan')).toBe(false)
    expect(isCanonicalSectionPath('/settings')).toBe(false)
    expect(sectionLabel('devices')).toBe('设备与引擎')
  })
})
