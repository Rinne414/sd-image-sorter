import { describe, expect, test } from 'vitest'
import { parseSearch, suggestionContext, toImageParams, withoutToken } from './searchQuery'

const scope = { generators: [], folder: null, favoritesCollectionId: null }
const params = (q: string) => toImageParams(parseSearch(q, new Date(2026, 8, 25)), scope, 'newest')

describe('parseSearch', () => {
  test('free text and key:value filters', () => {
    expect(params('silver hair tag:school_uniform gen:novelai')).toEqual({
      sort_by: 'newest',
      search: 'silver hair',
      tags: 'school_uniform',
      generators: 'nai',
    })
  })

  test('negation goes to the exclude lists; != is the same as -', () => {
    expect(params('-tag:blurry rating!=explicit -gen:comfyui')).toMatchObject({
      exclude_tags: 'blurry',
      exclude_ratings: 'explicit',
      exclude_generators: 'comfyui',
    })
  })

  test('numbers: bounds, ranges, spaces around operators, score:N means at least N', () => {
    expect(params('score >= 7 width<=2048 height:1024 sat:40..60')).toMatchObject({
      min_aesthetic: 7,
      max_width: 2048,
      min_height: 1024,
      max_height: 1024,
      min_saturation: 40,
      max_saturation: 60,
    })
    expect(params('score:7')).toMatchObject({ min_aesthetic: 7 })
    expect(params('score:7')).not.toHaveProperty('max_aesthetic')
    expect(params('score:none')).toMatchObject({ aesthetic_unscored: true })
  })

  test('stars: ★N shorthand, >= and >, never an upper bound', () => {
    expect(params('★4')).toMatchObject({ min_user_rating: 4 })
    expect(params('stars>=3')).toMatchObject({ min_user_rating: 3 })
    expect(params('星级>3')).toMatchObject({ min_user_rating: 4 })
    const q = parseSearch('stars<=2')
    expect(q.parts[0]).toMatchObject({ kind: 'warn', reason: 'starsMinOnly' })
  })

  test('chinese keys and values', () => {
    expect(params('标签:smile 分级:普通 比例:竖图 颜色:暖')).toMatchObject({
      tags: 'smile',
      ratings: 'general',
      aspect_ratio: 'portrait',
      color_temperature: 'warm',
    })
  })

  test('colours: temperature words vs hues, both negatable', () => {
    expect(params('color:red -color:blue -color:cool')).toMatchObject({
      color_hues: 'red',
      exclude_color_hues: 'blue',
      exclude_colors: 'cool',
    })
  })

  test('dates: month, range, relative days, bounds', () => {
    expect(params('date:2026-02')).toMatchObject({ date_from: '2026-02-01', date_to: '2026-02-28' })
    expect(params('date:2026-05-01..2026-05-31')).toMatchObject({ date_from: '2026-05-01', date_to: '2026-05-31' })
    expect(params('date:7d')).toMatchObject({ date_from: '2026-09-19', date_to: '2026-09-25' })
    expect(params('date:today')).toMatchObject({ date_from: '2026-09-25', date_to: '2026-09-25' })
    expect(params('date>2026-05')).toMatchObject({ date_from: '2026-06-01' })
  })

  test('size, seed, has/no, artist, folder, quoted values, contains()', () => {
    expect(params('size:1024x1536 seed:314159 no:caption has:params artist:wlop folder:"AAA ref" contains(red)')).toMatchObject({
      min_width: 1024,
      max_width: 1024,
      min_height: 1536,
      max_height: 1536,
      seed: 314159,
      no_caption: true,
      has_metadata: true,
      artist: 'wlop',
      folder: 'AAA ref',
      search: 'red',
    })
    expect(params('prompt:"long hair"')).toMatchObject({ prompts: 'long hair' })
  })

  test('bad values warn with the legal ones; unknown keys stay free text', () => {
    const q = parseSearch('rating:blue gen:midjourney foo:bar width:wide')
    const reasons = q.parts.filter((p) => p.kind === 'warn').map((p) => (p.kind === 'warn' ? p.reason : ''))
    expect(reasons).toEqual(['rating', 'generator', 'number'])
    expect(q.freeText).toEqual(['foo:bar'])
  })

  test('negating a key that cannot be negated warns instead of filtering', () => {
    const q = parseSearch('-score:7')
    expect(q.parts[0]).toMatchObject({ kind: 'warn', reason: 'notNegatable' })
    expect(toImageParams(q, scope, 'newest')).toEqual({ sort_by: 'newest' })
  })

  test('the rail scope merges in; a folder: token wins over the rail folder', () => {
    const q = parseSearch('gen:nai')
    expect(toImageParams(q, { generators: ['comfyui'], folder: 'L:/a', favoritesCollectionId: 1 }, 'oldest')).toEqual({
      sort_by: 'oldest',
      generators: 'comfyui,nai',
      folder: 'L:/a',
      collection_id: 1,
    })
    expect(toImageParams(parseSearch('folder:L:/b'), { ...scope, folder: 'L:/a' }, 'newest')).toMatchObject({ folder: 'L:/b' })
  })
})

describe('chips', () => {
  test('every part remembers its token, so a chip can be removed', () => {
    const q = parseSearch('silver tag:smile -tag:blurry')
    const tagChip = q.parts.find((p) => p.kind === 'filter' && p.key === 'tag')
    expect(tagChip).toBeDefined()
    expect(withoutToken(q.tokens, tagChip!.token)).toBe('silver -tag:blurry')
  })
})

describe('suggestionContext', () => {
  test('library keys wait for a first character', () => {
    expect(suggestionContext('tag:', 4)).toBeNull()
    expect(suggestionContext('tag:sil', 7)).toMatchObject({ source: 'library', endpoint: 'tags', prefix: 'sil', valueStart: 4 })
  })

  test('enum keys suggest their values; negation keeps the value offset right', () => {
    expect(suggestionContext('a -gen:n', 8)).toMatchObject({ source: 'enum', key: 'generator', prefix: 'n', valueStart: 7 })
  })

  test('plain words are not suggestion targets', () => {
    expect(suggestionContext('silver hair', 6)).toBeNull()
  })
})
