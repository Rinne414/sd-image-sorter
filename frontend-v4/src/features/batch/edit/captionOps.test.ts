import { describe, expect, it } from 'vitest'
import type { CaptionContent } from '../datasetTag'
import { splitTags, tagKey } from './captionContent'
import { applyOp, CATEGORY_ORDER, dedupeTags, findPattern, hasDuplicateTags, planOp, tagFrequency, type BulkOp } from './captionOps'
import { traitFamily, traitMarks } from './tagInsights'

const c = (booru: string, nl = '', type: CaptionContent['caption_type'] = 'booru'): CaptionContent => ({
  content_version: 1,
  booru_caption: booru,
  nl_caption: nl,
  caption_type: type,
})

const CATEGORIES: Record<string, string> = { '1girl': 'meta', smile: 'expression', 'long hair': 'body', dress: 'outfit', 'mychar': 'character' }
const categoryOf = (tag: string) => CATEGORIES[tagKey(tag)] ?? 'unknown'
const run = (booru: string, op: BulkOp, nl = '') => applyOp(c(booru, nl), op, categoryOf)

describe('tags are split and compared like the backend caption transforms', () => {
  // Expected values produced by services.tag_export.captions
  // (_split_caption_transform_tokens / _normalize_caption_transform_token / apply_caption_transforms).
  it('splits the same way', () => {
    const cases: [string, string[]][] = [
      ['1girl, long_hair ,  smile', ['1girl', 'long_hair', 'smile']],
      [' a_b ,\n c  d,, ', ['a_b', 'c d']],
      ['Long_Hair, long hair, LONG  HAIR', ['Long_Hair', 'long hair', 'LONG HAIR']],
      ['  ,, ', []],
      ['score_9, score_8_up', ['score_9', 'score_8_up']],
      ['tag\twith\ttabs, x', ['tag with tabs', 'x']],
    ]
    for (const [text, tags] of cases) expect(splitTags(text)).toEqual(tags)
  })

  it('treats any case, _ or space as one tag', () => {
    const cases: [string, string][] = [
      ['Long_Hair', 'long hair'],
      ['  a   b ', 'a b'],
      ['score_9_up', 'score 9 up'],
      ['X\tY', 'x y'],
    ]
    for (const [tag, key] of cases) expect(tagKey(tag)).toBe(key)
  })

  it('dedupes keeping the first spelling, as apply_caption_transforms does', () => {
    // apply_caption_transforms("smile, long_hair, Long hair, watermark", prepend mychar, remove WATERMARK) == "mychar, smile, long_hair"
    const after = run('smile, long_hair, Long hair, watermark', { kind: 'remove', tags: ['WATERMARK'] })
    expect(['mychar', ...dedupeTags(splitTags(after.booru_caption))].join(', ')).toBe('mychar, smile, long_hair')
  })
})

describe('bulk operations on one caption', () => {
  it('adds at the front or the back, moving a tag already there', () => {
    expect(run('smile, dress', { kind: 'add', tags: ['solo, 1girl'], position: 'front' }).booru_caption).toBe('solo, 1girl, smile, dress')
    expect(run('smile, solo, dress', { kind: 'add', tags: ['SOLO'], position: 'back' }).booru_caption).toBe('smile, dress, SOLO')
  })

  it('removes by any spelling', () => {
    expect(run('long_hair, smile', { kind: 'remove', tags: ['Long Hair'] }).booru_caption).toBe('smile')
  })

  it('finds and replaces a whole tag, text, or a pattern; tags or words or both', () => {
    const tag: BulkOp = { kind: 'replace', find: 'long_hair', replace: 'very long hair, hair ornament', mode: 'tag', target: 'tags', ignoreCase: false }
    expect(run('1girl, Long Hair, smile', tag).booru_caption).toBe('1girl, very long hair, hair ornament, smile')
    const gone: BulkOp = { ...tag, replace: '' }
    expect(run('1girl, long hair', gone).booru_caption).toBe('1girl')
    const text: BulkOp = { kind: 'replace', find: 'hair', replace: 'locks', mode: 'text', target: 'both', ignoreCase: false }
    expect(run('long hair, smile', text, 'Her hair shines.')).toEqual(c('long locks, smile', 'Her locks shines.'))
    const regex: BulkOp = { kind: 'replace', find: '^(\\w+)_hair$', replace: '$1 hair', mode: 'regex', target: 'tags', ignoreCase: false }
    // per tag: ^ and $ are each tag's ends
    expect(run('1girl, long_hair, hair_ornament', regex).booru_caption).toBe('1girl, long hair, hair_ornament')
    const words: BulkOp = { kind: 'replace', find: 'GIRL', replace: 'woman', mode: 'text', target: 'words', ignoreCase: true }
    expect(run('1girl', words, 'A girl.')).toEqual(c('1girl', 'A woman.'))
  })

  it('an unusable pattern says why and changes nothing', () => {
    expect(findPattern('(', 'regex', false)).toHaveProperty('error')
    expect(run('a, b', { kind: 'replace', find: '(', replace: '', mode: 'regex', target: 'tags', ignoreCase: false }).booru_caption).toBe('a, b')
  })

  it('dedupes, drops categories, sorts by category, sets the type', () => {
    expect(run('smile, Smile, dress', { kind: 'dedupe' }).booru_caption).toBe('smile, dress')
    expect(run('1girl, smile, dress', { kind: 'removeCategories', categories: ['meta', 'outfit'] }).booru_caption).toBe('smile')
    expect(run('zzz, smile, 1girl, dress, mychar, long hair', { kind: 'sortByCategory', order: CATEGORY_ORDER }).booru_caption).toBe(
      'mychar, long hair, smile, dress, 1girl, zzz',
    )
    expect(run('a', { kind: 'type', type: 'both' }).caption_type).toBe('both')
  })
})

describe('many captions', () => {
  it('plans only the captions that change', () => {
    const contents = new Map([
      ['a', c('smile, dress')],
      ['b', c('dress')],
      ['c', c('smile')],
    ])
    const changes = planOp(contents, ['a', 'b', 'c', 'missing'], { kind: 'remove', tags: ['smile'] }, categoryOf)
    expect(changes.map((ch) => [ch.key, ch.after.booru_caption])).toEqual([
      ['a', 'dress'],
      ['c', ''],
    ])
    expect(changes[0]?.before.booru_caption).toBe('smile, dress')
  })

  it('counts each tag once per caption, most used first, in its usual spelling', () => {
    const rows = tagFrequency([
      ['a', c('long_hair, smile, smile')],
      ['b', c('long hair')],
      ['c', c('long_hair, dress')],
    ])
    expect(rows.map((r) => [r.tag, r.count, r.keys])).toEqual([
      ['long_hair', 3, ['a', 'b', 'c']],
      ['dress', 1, ['c']],
      ['smile', 1, ['a']],
    ])
    expect(hasDuplicateTags(c('smile, Smile'))).toBe(true)
    expect(hasDuplicateTags(c('smile'))).toBe(false)
  })
})

describe('character traits (the backend trait_pruning_service rules, on the captions)', () => {
  it('names the same family as classify_trait_family', () => {
    // Produced by services.trait_pruning_service.classify_trait_family.
    const expected: Record<string, string | null> = {
      silver_hair: 'hair', 'long hair': 'hair', hair_ornament: null, wet_hair: null, twintails: 'hair', red_eyes: 'eyes',
      closed_eyes: null, slit_pupils: 'eyes', heterochromia: 'eyes', dark_skin: 'skin', shiny_skin: null, tan: 'skin',
      large_breasts: 'body', cat_ears: 'body', fox_tail: 'body', wings: 'body', demon_horns: 'body', mole_under_eye: 'body',
      smile: null, '1girl': null, 'Blue Eyes': 'eyes', hair_between_eyes: 'hair', hairclip: null,
    }
    for (const [tag, family] of Object.entries(expected)) expect([tag, traitFamily(tag)]).toEqual([tag, family])
  })

  it('suggests traits most captions in scope share', () => {
    const rows = tagFrequency([
      ['a', c('silver hair, red eyes, smile')],
      ['b', c('silver_hair, smile')],
      ['c', c('silver hair, red eyes')],
      ['d', c('dress')],
    ])
    const marks = traitMarks(rows, 4)
    expect([...marks]).toEqual([['silver hair', { family: 'hair', ratio: 0.75 }]])
  })
})
