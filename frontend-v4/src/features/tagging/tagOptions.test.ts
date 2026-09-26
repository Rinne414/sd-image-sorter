import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  CUSTOM_MODEL,
  clearTagOptions,
  customPathProblem,
  hasStoredTagOptions,
  librarySmartTagBody,
  loadAdvancedOpen,
  loadTagOptions,
  rememberedThresholds,
  saveAdvancedOpen,
  saveTagOptions,
  tagStartBody,
  type RunChoice,
  type TagOptions,
} from './tagOptions'

const KEY = 'sd-v4-tag-options'

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

const base: TagOptions = {
  model: 'wd-swinv2-tagger-v3',
  threshold: null,
  characterThreshold: null,
  copyrightThreshold: null,
  useGpu: true,
  blacklist: [],
  maxTags: 0,
  autoStripNoise: true,
  mergeStrategy: 'replace',
  custom: { profile: 'wd14', modelPath: '', tagsPath: '' },
}

const tagAndDescribe: RunChoice = { tagger: true, describer: 'vlm', toriiLength: 'detailed', grounding: true }

describe('defaults are V3.5 defaults', () => {
  test('nothing stored: replace, strip noise on, no custom file', () => {
    expect(loadTagOptions('wd-swinv2-tagger-v3')).toEqual(base)
    expect(loadAdvancedOpen()).toBe(false)
  })
})

describe('the plain tag run (POST /api/tag/start)', () => {
  test('a built-in tagger sends no custom fields', () => {
    const body = tagStartBody([1, 2], { ...base, threshold: 0.5 })
    expect(body).toMatchObject({ image_ids: [1, 2], model_name: 'wd-swinv2-tagger-v3', threshold: 0.5, character_threshold: null })
    for (const key of ['model_path', 'tags_path', 'custom_profile']) expect(key in body).toBe(false)
  })

  test('a custom ONNX file sends its type and paths the way V3.5 does', () => {
    const custom = { ...base, model: CUSTOM_MODEL, custom: { profile: 'camie-tagger-v2' as const, modelPath: '  D:\\m\\camie.onnx ', tagsPath: 'D:\\m\\meta.json' } }
    expect(tagStartBody(null, custom)).toMatchObject({
      model_name: 'camie-tagger-v2',
      model_path: 'D:\\m\\camie.onnx',
      tags_path: 'D:\\m\\meta.json',
      custom_profile: 'camie-tagger-v2',
    })
    expect('image_ids' in tagStartBody(null, custom)).toBe(false)
    // no tags file: the backend looks beside the model
    const noTags = tagStartBody([3], { ...custom, custom: { ...custom.custom, tagsPath: ' ' } })
    expect(noTags.tags_path).toBeNull()
  })
})

describe('the Smart Tag run for Library picks', () => {
  test('tag and describe: every new option reaches the body', () => {
    const body = librarySmartTagBody([4, 5], { ...base, copyrightThreshold: 0.4, autoStripNoise: false, mergeStrategy: 'append' }, tagAndDescribe)
    expect(body).toMatchObject({
      image_ids: [4, 5],
      image_paths: [],
      enable_wd14: true,
      enable_vlm: true,
      natural_language_mode: 'vlm',
      merge_strategy: 'append',
      auto_strip_noise: false,
      copyright_threshold: 0.4,
      skip_existing: false,
      tagger_model: 'wd-swinv2-tagger-v3',
      trigger_word: '',
    })
  })

  test('defaults: replace, strip noise, the tagger picks its own copyright threshold', () => {
    const body = librarySmartTagBody([4], base, tagAndDescribe)
    expect(body).toMatchObject({ merge_strategy: 'replace', auto_strip_noise: true })
    expect('copyright_threshold' in body).toBe(false)
    expect('general_threshold' in body).toBe(false)
  })

  test('describe only: the tagger is off, no thresholds, the local captioner writes', () => {
    const body = librarySmartTagBody([4], { ...base, threshold: 0.6, copyrightThreshold: 0.3 }, { tagger: false, describer: 'florence2', toriiLength: 'brief', grounding: false })
    expect(body).toMatchObject({
      enable_wd14: false,
      enable_vlm: true,
      natural_language_mode: 'florence2',
      tagger_model: '',
      skip_existing: false,
      toriigate_caption_length: 'brief',
      vlm_grounding: false,
      toriigate_grounding: false,
    })
    for (const key of ['general_threshold', 'character_threshold', 'copyright_threshold']) expect(key in body).toBe(false)
  })
})

describe('remembered choices', () => {
  test('copyright threshold per tagger, strip noise, merge and the custom file are remembered', () => {
    const custom = { profile: 'pixai-tagger-v0.9' as const, modelPath: 'D:\\m\\p.onnx', tagsPath: '' }
    saveTagOptions({ ...base, copyrightThreshold: 0.45, autoStripNoise: false, mergeStrategy: 'append', custom })
    expect(loadTagOptions('x')).toMatchObject({ copyrightThreshold: 0.45, autoStripNoise: false, mergeStrategy: 'append', custom })
    expect(rememberedThresholds('wd-swinv2-tagger-v3')).toEqual({ general: null, character: null, copyright: 0.45 })
    expect(rememberedThresholds('camie-tagger-v2')).toEqual({ general: null, character: null, copyright: null })
  })

  test('the custom model stays chosen with its own thresholds', () => {
    saveTagOptions({ ...base, model: CUSTOM_MODEL, threshold: 0.3, custom: { profile: 'wd14', modelPath: 'D:\\a.onnx', tagsPath: '' } })
    expect(loadTagOptions('wd-swinv2-tagger-v3')).toMatchObject({ model: CUSTOM_MODEL, threshold: 0.3 })
  })

  test('whether Advanced is open is remembered and survives saving the options', () => {
    saveAdvancedOpen(true)
    saveTagOptions(base)
    expect(loadAdvancedOpen()).toBe(true)
    saveAdvancedOpen(false)
    expect(loadAdvancedOpen()).toBe(false)
  })

  test('reset forgets every new field too', () => {
    saveTagOptions({ ...base, copyrightThreshold: 0.45, autoStripNoise: false, mergeStrategy: 'append', custom: { profile: 'wd14', modelPath: 'D:\\a.onnx', tagsPath: '' } })
    saveAdvancedOpen(true)
    expect(hasStoredTagOptions()).toBe(true)
    clearTagOptions()
    expect(hasStoredTagOptions()).toBe(false)
    expect(loadTagOptions('wd-swinv2-tagger-v3')).toEqual(base)
    expect(loadAdvancedOpen()).toBe(false)
  })

  test('bad stored values fall back to the defaults', () => {
    store.set(KEY, JSON.stringify({ mergeStrategy: 'merge', autoStripNoise: 'yes', custom: { profile: 'toriigate-0.5', modelPath: 3 } }))
    expect(loadTagOptions('m')).toMatchObject({ mergeStrategy: 'replace', autoStripNoise: true, custom: { profile: 'wd14', modelPath: '', tagsPath: '' } })
  })
})

describe('custom ONNX path errors in plain words', () => {
  test('the backend refusals map to what went wrong', () => {
    expect(customPathProblem('Custom ONNX tagger model must be an .onnx file.')).toEqual({ field: 'model', kind: 'ext' })
    expect(customPathProblem('Custom ONNX tagger model path is invalid: File does not exist.')).toEqual({ field: 'model', kind: 'missing' })
    expect(customPathProblem('Custom ONNX tagger model path is invalid: Path is not a file.')).toEqual({ field: 'model', kind: 'notFile' })
    expect(customPathProblem('Custom ONNX tagger model path is invalid: Path contains invalid filename characters.')).toEqual({ field: 'model', kind: 'bad' })
    expect(customPathProblem('Custom tags/metadata file for camie-tagger-v2 must be .json.')).toEqual({ field: 'tags', kind: 'ext' })
    expect(customPathProblem('Custom tags/metadata path for wd14 is invalid: File does not exist.')).toEqual({ field: 'tags', kind: 'missing' })
    expect(customPathProblem('Custom tags/metadata path for wd14 is invalid: Path is not a file.')).toEqual({ field: 'tags', kind: 'notFile' })
    expect(customPathProblem('Tagger is busy')).toBeNull()
  })
})
