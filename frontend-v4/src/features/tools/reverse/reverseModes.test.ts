import { describe, expect, it } from 'vitest'
import {
  appendTags,
  captionOf,
  draftTags,
  MODES,
  needsTagger,
  needsVlm,
  promptToTags,
  smartTagBody,
  tagSingleBody,
  tagsToPrompt,
  tipoOffFor,
} from './reverseModes'
import type { TagOptions } from '../../tagging/tagJob'

const tagger: TagOptions = {
  model: 'pixai-tagger-v1.0',
  threshold: 0.4,
  characterThreshold: null,
  copyrightThreshold: null,
  useGpu: false,
  blacklist: ['watermark'],
  maxTags: 0,
  autoStripNoise: true,
  mergeStrategy: 'replace',
  custom: { profile: 'wd14', modelPath: '', tagsPath: '' },
}

describe('the three ways to work out a prompt', () => {
  it('are tagger, vision model, and tags handed to the vision model', () => {
    expect(MODES).toEqual(['grounded', 'tagger', 'vlm'])
    expect([needsTagger('tagger'), needsTagger('vlm'), needsTagger('grounded')]).toEqual([true, false, true])
    expect([needsVlm('tagger'), needsVlm('vlm'), needsVlm('grounded')]).toEqual([false, true, true])
  })

  it('the tagger runs with the tagger the user chose in the tag panel', () => {
    expect(tagSingleBody('C:/tmp/a.png', tagger)).toEqual({ image_path: 'C:/tmp/a.png', tagger_model: 'pixai-tagger-v1.0', general_threshold: 0.4, use_gpu: false })
  })

  it('a Smart Tag run reads one file, writes nothing and names its tagger', () => {
    const body = smartTagBody('grounded', 'C:/tmp/a.png', '', tagger)
    expect(body).toMatchObject({
      image_paths: ['C:/tmp/a.png'],
      enable_wd14: true,
      enable_vlm: true,
      vlm_grounding: true,
      merge_strategy: 'replace',
      skip_existing: false,
      tagger_model: 'pixai-tagger-v1.0',
      general_threshold: 0.4,
      use_gpu: false,
    })
    expect(body).not.toHaveProperty('caption_profile')
    expect(smartTagBody('vlm', 'p', '', tagger)).toMatchObject({ enable_wd14: false, enable_vlm: true, vlm_grounding: false })
  })

  it('Krea 2 asks the vision model for its long natural-language profile', () => {
    expect(smartTagBody('vlm', 'p', 'krea2', tagger)).toMatchObject({ caption_profile: 'krea2_long_nl' })
    expect(smartTagBody('vlm', 'p', 'flux', tagger)).not.toHaveProperty('caption_profile')
    expect(tipoOffFor('krea2')).toBe(true)
    expect(tipoOffFor('sdxl')).toBe(false)
    expect(tipoOffFor('')).toBe(false)
  })
})

describe('tags and the draft', () => {
  it('turns tags into a prompt: spaces, no repeats, score tags kept as written', () => {
    expect(tagsToPrompt(['1girl', 'silver_hair', 'score_9', '1girl'])).toBe('1girl, silver hair, score_9')
    expect(promptToTags(' a, b ,, c ')).toEqual(['a', 'b', 'c'])
  })

  it('sends TIPO only the parts of the draft that read as tags', () => {
    expect(draftTags('1girl, silver hair, She stands in the rain. It is late, smile')).toEqual(['1girl', 'silver hair', 'smile'])
  })

  it('adds tags to the draft once, ignoring case and underscores', () => {
    expect(appendTags('1girl, Silver hair', ['silver_hair', 'rain', 'RAIN'])).toEqual({ text: '1girl, Silver hair, rain', added: 1 })
    expect(appendTags('', ['a_b'])).toEqual({ text: 'a b', added: 1 })
  })
})

describe('a finished Smart Tag run', () => {
  it('gives its caption, or the reason it has none (never an empty success)', () => {
    expect(captionOf({ results: [{ caption: ' a girl in rain ' }] }, {})).toEqual({ prompt: 'a girl in rain' })
    expect(captionOf({ results: [{ caption: '' }] }, { errors: [{ error: 'VLM timed out' }] })).toEqual({ error: 'VLM timed out' })
    expect(captionOf({ results: [] }, { message: 'Done. 1 ok, 0 failed.' })).toEqual({ error: null })
  })
})
