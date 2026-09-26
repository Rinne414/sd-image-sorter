import { describe, expect, test } from 'vitest'
import { DEFAULT_PREFS, modelConfig, parsePrefs, toStored } from './artistPrefs'

// The style tool's settings are remembered in the key V3.5 already uses
// (sd-image-sorter-artist-defaults-v1), so both apps share them.

describe('style tool settings', () => {
  test('nothing stored, or something unreadable, gives the defaults', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS)
    expect(parsePrefs('nope')).toEqual(DEFAULT_PREFS)
    expect(DEFAULT_PREFS).toMatchObject({ modelSource: 'huggingface', modelPath: '', threshold: 0.03, useGpu: true, skipExisting: true })
  })

  test('reads what V3.5 saved', () => {
    const v35 = { version: 1, savedAt: '2026-01-01', modelSource: 'modelscope', modelPath: '', threshold: 0.1, useGpu: false }
    expect(parsePrefs(v35)).toEqual({ ...DEFAULT_PREFS, modelSource: 'modelscope', threshold: 0.1, useGpu: false })
  })

  test('a threshold outside 0 to 0.25 or an unknown source falls back', () => {
    expect(parsePrefs({ threshold: 0.9 }).threshold).toBe(0.03)
    expect(parsePrefs({ threshold: -1 }).threshold).toBe(0.03)
    expect(parsePrefs({ threshold: 0.25 }).threshold).toBe(0.25)
    expect(parsePrefs({ modelSource: 'civitai' }).modelSource).toBe('huggingface')
  })

  test('stored in the V3.5 shape, plus the skip choice', () => {
    const stored = toStored({ ...DEFAULT_PREFS, modelSource: 'local', modelPath: ' D:\\k.pth ', skipExisting: false })
    expect(stored).toMatchObject({ version: 1, modelSource: 'local', modelPath: 'D:\\k.pth', threshold: 0.03, useGpu: true, skipExisting: false })
    expect(parsePrefs(stored)).toMatchObject({ modelSource: 'local', modelPath: 'D:\\k.pth', skipExisting: false })
  })

  test('what the backend gets; a local source needs its path', () => {
    expect(modelConfig(DEFAULT_PREFS)).toEqual({ model_source: 'huggingface', model_path: null, use_gpu: true })
    expect(modelConfig({ ...DEFAULT_PREFS, modelSource: 'local', modelPath: '' })).toBeNull()
    expect(modelConfig({ ...DEFAULT_PREFS, modelSource: 'local', modelPath: 'D:\\k.pth', useGpu: false })).toEqual({
      model_source: 'local',
      model_path: 'D:\\k.pth',
      use_gpu: false,
    })
  })
})
