import { describe, expect, test } from 'vitest'
import { isSettingKey, resetAllSettings } from './resetSettings'

function memoryStore(entries: Record<string, string>) {
  const data = new Map(Object.entries(entries))
  return {
    data,
    get length() {
      return data.size
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
  }
}

describe('reset all settings', () => {
  test('removes preferences and keeps the user\'s work', () => {
    const store = memoryStore({
      'sd-v4-prefs': '{}',
      'sd-v4-ui-scale': '1.3',
      'sd-image-sorter-lang': 'en',
      'sd-v4-censor-size': '40',
      'sort-audio-enabled': '1',
      // work and state: kept
      'sd-library-workspace-v1': '{"v":2,"currentId":"lib_x"}',
      'sd-v4-browse': '{}',
      'sd-v4-saved-searches': '[]',
      'sd-v4-reverse-draft': 'a prompt',
      'sd-image-sorter-recent-folders': '[]',
      'sd-v4-dataset-tag-runs': '[]',
    })
    const removed = resetAllSettings(store)
    expect(removed.sort()).toEqual(['sd-image-sorter-lang', 'sd-v4-censor-size', 'sd-v4-prefs', 'sd-v4-ui-scale', 'sort-audio-enabled'])
    expect([...store.data.keys()].sort()).toEqual([
      'sd-image-sorter-recent-folders',
      'sd-library-workspace-v1',
      'sd-v4-browse',
      'sd-v4-dataset-tag-runs',
      'sd-v4-reverse-draft',
      'sd-v4-saved-searches',
    ])
  })

  test('a key outside the list is never a setting', () => {
    expect(isSettingKey('sd-v4-scroll')).toBe(false)
    expect(isSettingKey('something-else')).toBe(false)
    expect(isSettingKey('sd-v4-censor-pen-color')).toBe(true)
  })
})

describe('AI defaults', () => {
  test('both saved defaults (the keys V3.5 uses) are preferences, so Reset all settings removes them', () => {
    expect(isSettingKey('sd-image-sorter-tagger-defaults-v1')).toBe(true)
    expect(isSettingKey('sd-image-sorter-artist-defaults-v1')).toBe(true)
  })
})

describe('top bar places', () => {
  test('both interfaces keep their customized bar as a preference, so Reset all settings restores it', () => {
    expect(isSettingKey('sd-v4-nav-places')).toBe(true)
    expect(isSettingKey('sd-next-nav-places')).toBe(true)
  })
})
