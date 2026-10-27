import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ARTIST_KEY } from '../../tools/artist/artistPrefs'
import { FALLBACK_THRESHOLD, TAGGER_DEFAULTS_KEY, parseTaggerDefaults, taggerDefaultsOf } from '../../tagging/savedDefaults'
import { TAG_OPTIONS_KEY, loadTagOptions, saveTagOptions, type TagOptions } from '../../tagging/tagOptions'
import { DEFAULT_KEYS, artistLine, artistPrefsOf, restoreSnapshot, takeSnapshot, taggerLine } from './defaultsState'

let store: Map<string, string>
beforeEach(() => {
  store = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
})
afterEach(() => vi.unstubAllGlobals())

const options: TagOptions = {
  model: 'pixai-tagger-v1.0',
  threshold: null,
  characterThreshold: 0.9,
  copyrightThreshold: null,
  useGpu: false,
  blacklist: [],
  maxTags: 0,
  autoStripNoise: true,
  mergeStrategy: 'replace',
  custom: { profile: 'camie-tagger-v2', modelPath: ' D:\\m.onnx ', tagsPath: '' },
}

describe('saved tagger defaults', () => {
  test('are written in V3.5\u2019s shape, a tagger\u2019s own thresholds written out', () => {
    const payload = taggerDefaultsOf(options, { threshold: 0.3, characterThreshold: 0.8 }, null)
    expect(payload).toMatchObject({
      version: 1,
      modelName: 'pixai-tagger-v1.0',
      threshold: 0.3,
      characterThreshold: 0.9,
      useGpu: false,
      batchSize: '',
      customProfile: 'camie-tagger-v2',
      customModelPath: 'D:\\m.onnx',
      customTagsPath: '',
    })
  })

  test('with no thresholds known, V3.5\u2019s own numbers are used (V3.5 reads a missing number as 0)', () => {
    const payload = taggerDefaultsOf({ ...options, characterThreshold: null }, {}, null)
    expect(payload.threshold).toBe(FALLBACK_THRESHOLD)
    expect(payload.characterThreshold).toBe(0.85)
  })

  test('V3.5\u2019s batch size is kept as it was saved', () => {
    const previous = parseTaggerDefaults({ modelName: 'm', batchSize: '8' })
    expect(taggerDefaultsOf(options, {}, previous).batchSize).toBe('8')
  })

  test('nothing usable without a tagger name', () => {
    expect(parseTaggerDefaults(null)).toBeNull()
    expect(parseTaggerDefaults({ modelName: '  ' })).toBeNull()
    expect(parseTaggerDefaults({ modelName: 'm', threshold: 7 })).toMatchObject({ threshold: null })
  })
})

describe('the tag panel starts from them', () => {
  test('with nothing remembered, the saved defaults are the start', () => {
    store.set(TAGGER_DEFAULTS_KEY, JSON.stringify(taggerDefaultsOf(options, { threshold: 0.3, characterThreshold: 0.8 }, null)))
    expect(loadTagOptions('wd-swinv2-tagger-v3')).toMatchObject({
      model: 'pixai-tagger-v1.0',
      threshold: 0.3,
      characterThreshold: 0.9,
      useGpu: false,
      custom: { profile: 'camie-tagger-v2', modelPath: 'D:\\m.onnx', tagsPath: '' },
    })
  })

  test('what is remembered from the last run wins over them', () => {
    store.set(TAGGER_DEFAULTS_KEY, JSON.stringify(taggerDefaultsOf(options, {}, null)))
    saveTagOptions({ ...options, model: 'wd-swinv2-tagger-v3', threshold: 0.5 })
    expect(loadTagOptions('x')).toMatchObject({ model: 'wd-swinv2-tagger-v3', threshold: 0.5 })
  })

  test('without either, the program\u2019s own', () => {
    expect(loadTagOptions('wd-swinv2-tagger-v3')).toMatchObject({ model: 'wd-swinv2-tagger-v3', threshold: null, useGpu: true })
  })
})

describe('the lines under the title', () => {
  test('tagger: two decimals, GPU unless saved off, none saved is null', () => {
    expect(taggerLine(null)).toBeNull()
    expect(taggerLine(parseTaggerDefaults({ modelName: 'm', threshold: 0.35, characterThreshold: 0.85, useGpu: false }))).toEqual({
      model: 'm',
      general: '0.35',
      character: '0.85',
      device: 'cpu',
    })
    expect(taggerLine(parseTaggerDefaults({ modelName: 'm' }))).toMatchObject({ general: '0.35', character: '0.85', device: 'gpu' })
  })

  test('style finder: nothing stored is null; a damaged value reads as the defaults', () => {
    expect(artistLine(null)).toBeNull()
    expect(artistLine('{not json')).toEqual({ source: 'huggingface', threshold: '0.03', device: 'gpu' })
    expect(artistLine(JSON.stringify({ modelSource: 'local', threshold: 0.1, useGpu: false }))).toEqual({ source: 'local', threshold: '0.10', device: 'cpu' })
  })
})

describe('a reset can be undone', () => {
  test('every key comes back as it was, the ones that were not set stay unset', () => {
    store.set(TAGGER_DEFAULTS_KEY, '{"modelName":"m"}')
    store.set(ARTIST_KEY, '{"modelSource":"modelscope","threshold":0.2,"useGpu":false}')
    const before = takeSnapshot(localStorage)
    expect(Object.keys(before)).toEqual([...DEFAULT_KEYS])
    expect(before[TAG_OPTIONS_KEY]).toBeNull()

    store.clear()
    store.set(TAG_OPTIONS_KEY, '{"model":"typed-after"}')
    restoreSnapshot(localStorage, before)

    expect(store.get(TAGGER_DEFAULTS_KEY)).toBe('{"modelName":"m"}')
    expect(store.get(ARTIST_KEY)).toContain('modelscope')
    expect(store.has(TAG_OPTIONS_KEY)).toBe(false)
    expect(artistPrefsOf(before)).toMatchObject({ modelSource: 'modelscope', threshold: 0.2, useGpu: false })
  })
})
