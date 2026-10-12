import { describe, expect, test } from 'vitest'
import { parseSearch, toImageParams } from './searchQuery'
import { toSelectionBody } from './selectionBody'

// Every key toImageParams can emit, with a value of the type it emits.
const EVERY_PARAM = {
  sort_by: 'newest',
  search: 'silver hair',
  tags: 'a,b',
  tag_mode: 'or',
  exclude_tags: 'c',
  checkpoints: 'model_a',
  exclude_checkpoints: 'model_b',
  loras: 'lora_a',
  exclude_loras: 'lora_b',
  prompts: 'smile',
  exclude_prompts: 'frown',
  prompt_match_mode: 'contains',
  generators: 'nai,comfyui',
  exclude_generators: 'webui',
  ratings: 'general',
  exclude_ratings: 'explicit',
  exclude_colors: 'cool',
  color_hues: 'red',
  exclude_color_hues: 'blue',
  min_aesthetic: 5,
  max_aesthetic: 8,
  aesthetic_unscored: true,
  min_user_rating: 3,
  min_width: 512,
  max_width: 2048,
  min_height: 512,
  max_height: 4096,
  aspect_ratio: 'portrait',
  color_temperature: 'warm',
  brightness_distribution: 'high_key',
  brightness_min: 10,
  brightness_max: 200,
  min_saturation: 20,
  max_saturation: 80,
  seed: 424242,
  date_from: '2026-09-01',
  date_to: '2026-09-25',
  artist: 'someone',
  folder: 'D:\\art',
  has_metadata: false,
  no_caption: true,
  collection_id: 7,
}

describe('toSelectionBody', () => {
  test('maps every gallery param onto the selection-ids body, lists split', () => {
    expect(toSelectionBody(EVERY_PARAM)).toEqual({
      sortBy: 'newest',
      search: 'silver hair',
      tags: ['a', 'b'],
      tagMode: 'or',
      excludeTags: ['c'],
      checkpoints: ['model_a'],
      excludeCheckpoints: ['model_b'],
      loras: ['lora_a'],
      excludeLoras: ['lora_b'],
      prompts: ['smile'],
      excludePrompts: ['frown'],
      promptMatchMode: 'contains',
      generators: ['nai', 'comfyui'],
      excludeGenerators: ['webui'],
      ratings: ['general'],
      excludeRatings: ['explicit'],
      excludeColors: ['cool'],
      colorHues: ['red'],
      excludeColorHues: ['blue'],
      minAesthetic: 5,
      maxAesthetic: 8,
      aestheticUnscored: true,
      minUserRating: 3,
      minWidth: 512,
      maxWidth: 2048,
      minHeight: 512,
      maxHeight: 4096,
      aspectRatio: 'portrait',
      colorTemperature: 'warm',
      brightnessDistribution: 'high_key',
      brightnessMin: 10,
      brightnessMax: 200,
      minSaturation: 20,
      maxSaturation: 80,
      seed: 424242,
      dateFrom: '2026-09-01',
      dateTo: '2026-09-25',
      artist: 'someone',
      folder: 'D:\\art',
      hasMetadata: false,
      noCaption: true,
      collectionId: 7,
    })
  })

  test('a key it does not know is an error, never a silently wider selection', () => {
    expect(() => toSelectionBody({ sort_by: 'newest', brand_new_filter: 'x' })).toThrow(/brand_new_filter/)
  })

  test('works on what the search line really produces', () => {
    const scope = { generators: ['nai'], folder: 'D:\\art', favoritesCollectionId: 3 }
    const params = toImageParams(parseSearch('silver tag:smile -rating:explicit ★4 aspect:portrait'), scope, 'name_asc')
    expect(toSelectionBody(params)).toEqual({
      sortBy: 'name_asc',
      search: 'silver',
      tags: ['smile'],
      excludeRatings: ['explicit'],
      minUserRating: 4,
      aspectRatio: 'portrait',
      generators: ['nai'],
      folder: 'D:\\art',
      collectionId: 3,
    })
  })

  test('empty list items are dropped', () => {
    expect(toSelectionBody({ sort_by: 'newest', tags: 'a,,b,' })).toEqual({ sortBy: 'newest', tags: ['a', 'b'] })
  })
})

describe('the match modes reach the every-match endpoints', () => {
  test('tag_mode and prompt_match_mode map to tagMode and promptMatchMode', () => {
    const params = toImageParams(parseSearch('tag:a|b prompt:*hair*'), { generators: [], folder: null, favoritesCollectionId: null }, 'newest')
    expect(toSelectionBody(params)).toEqual({
      sortBy: 'newest',
      tags: ['a', 'b'],
      tagMode: 'or',
      prompts: ['hair'],
      promptMatchMode: 'contains',
    })
  })
})
