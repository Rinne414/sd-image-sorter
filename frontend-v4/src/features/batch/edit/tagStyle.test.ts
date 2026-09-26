import { describe, expect, test } from 'vitest'
import type { CaptionContent } from '../datasetTag'
import { tagStyleIssues } from '../check/captionChecks'
import { applyOp, planOp } from './captionOps'
import { displayTag, isKaomojiTag, offStyleTags, styledList, styledTag, styleOf, withTagStyle } from './tagStyle'

const content = (booru: string): CaptionContent => ({ content_version: 1, booru_caption: booru, nl_caption: '', caption_type: 'booru' })
const unknown = () => 'unknown'

describe('writing a tag the way the batch template does', () => {
  test('the underscore option on (the default) writes spaces; off keeps underscores', () => {
    expect(styleOf(true)).toBe('spaces')
    expect(styleOf(false)).toBe('underscores')
    expect(styledTag('blue_sky', 'spaces')).toBe('blue sky')
    expect(styledTag(' long_hair_ribbon ', 'spaces')).toBe('long hair ribbon')
    expect(styledTag('blue sky', 'underscores')).toBe('blue_sky')
    expect(styledTag('blue_sky', 'underscores')).toBe('blue_sky')
    expect(styledTag('1girl', 'spaces')).toBe('1girl')
  })

  test('score_ tags keep their underscores, as the backend keeps them', () => {
    expect(styledTag('score_9', 'spaces')).toBe('score_9')
    expect(styledTag('score_8_up', 'spaces')).toBe('score_8_up')
  })

  test('emoticon tags keep their glyphs either way (the backend is_kaomoji_tag)', () => {
    for (const face of ['^_^', '>_<', 'o_o', '0_0', ';_;', '=_=', 'v_v', 'T_T', '<o>_<o>', '||_||', ':3', '\\o/']) {
      expect(isKaomojiTag(face), face).toBe(true)
      expect(styledTag(face, 'spaces'), face).toBe(face)
      expect(styledTag(face, 'underscores'), face).toBe(face)
    }
    expect(isKaomojiTag('blue_sky')).toBe(false)
    expect(isKaomojiTag('a_bc')).toBe(false)
    expect(isKaomojiTag('_')).toBe(false)
  })

  test('on screen: spaces for underscores, but emoticons and score_ tags keep their glyphs', () => {
    expect(displayTag('blue_sky')).toBe('blue sky')
    expect(displayTag('^_^')).toBe('^_^')
    expect(displayTag('>_<')).toBe('>_<')
    expect(displayTag('score_9')).toBe('score_9')
  })

  test('typed lists and whole captions are written one way; a caption already so is left as it is', () => {
    expect(styledList('red_ribbon, hair ornament\nscore_9', 'spaces')).toEqual(['red ribbon', 'hair ornament', 'score_9'])
    expect(offStyleTags('blue_sky, 1girl, ^_^, blue sky', 'spaces')).toEqual(['blue_sky'])
    const fine = content('blue sky,1girl')
    expect(withTagStyle(fine, 'spaces')).toBe(fine)
    expect(withTagStyle(content('blue_sky, 1girl, >_<'), 'spaces').booru_caption).toBe('blue sky, 1girl, >_<')
    expect(withTagStyle(content('blue sky, 1girl'), 'underscores').booru_caption).toBe('blue_sky, 1girl')
  })
})

describe('the bulk operation and the check', () => {
  const contents = new Map([
    ['lib:1', content('blue_sky, 1girl')],
    ['lib:2', content('hair ribbon, solo')],
    ['lib:3', { ...content('hair_ribbon, ^_^'), nl_caption: 'A girl.', caption_type: 'both' as const }],
  ])

  test('"write tags one way" changes only the captions with another spelling, and nothing else in them', () => {
    const changes = planOp(contents, [...contents.keys()], { kind: 'style', style: 'spaces' }, unknown)
    expect(changes.map((c) => c.key)).toEqual(['lib:1', 'lib:3'])
    expect(changes[1]?.after).toEqual({ ...content('hair ribbon, ^_^'), nl_caption: 'A girl.', caption_type: 'both' })
    expect(applyOp(content('blue sky'), { kind: 'style', style: 'underscores' }, unknown).booru_caption).toBe('blue_sky')
  })

  test('the check lists edited captions written another way, with a tag of each as the note', () => {
    const heads = new Map([...contents].map(([key, c]) => [key, { content: c }]))
    const [found, ...rest] = tagStyleIssues(heads, true)
    expect(rest).toEqual([])
    expect(found?.kind).toBe('tag_style')
    expect(found?.keys).toEqual(['lib:1', 'lib:3'])
    expect(found?.notes).toEqual({ 'lib:1': 'blue_sky', 'lib:3': 'hair_ribbon' })
    expect(tagStyleIssues(new Map([['lib:2', { content: content('hair ribbon') }]]), true)).toEqual([])
    expect(tagStyleIssues(heads, false)[0]?.keys).toEqual(['lib:2'])
  })
})
