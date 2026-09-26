import { describe, expect, test } from 'vitest'
import type { ProjectSettings } from '../datasetSettings'
import { withBlacklistedTag, withCommonTag } from './tagLists'

const settings = (common: string[], blacklist: string[]) =>
  ({ caption_render: { trigger: 'chkchar', common_tags: common, blacklist, normalize_tag_underscores: true } }) as unknown as ProjectSettings

describe('+ common tags from the tag frequency list', () => {
  test('adds the tag in the batch tag style: spaces, or underscores', () => {
    expect(withCommonTag(settings([], []), 'long_hair', true, 'spaces').caption_render.common_tags).toEqual(['long hair'])
    expect(withCommonTag(settings([], []), 'long hair', true, 'underscores').caption_render.common_tags).toEqual(['long_hair'])
  })

  test('once only, whatever way it was written before, and after the tags already there', () => {
    const next = withCommonTag(settings(['solo', 'Long_Hair'], []), 'long hair', true, 'spaces')
    expect(next.caption_render.common_tags).toEqual(['solo', 'long hair'])
  })

  test('a tag is on one list at a time: adding it to the common tags takes it off the blacklist', () => {
    const next = withCommonTag(settings([], ['long_hair', 'watermark']), 'long hair', true, 'spaces')
    expect(next.caption_render.common_tags).toEqual(['long hair'])
    expect(next.caption_render.blacklist).toEqual(['watermark'])
  })

  test('taking it out removes it from the common tags only', () => {
    const next = withCommonTag(settings(['solo', 'long hair'], ['watermark']), 'long_hair', false, 'spaces')
    expect(next.caption_render.common_tags).toEqual(['solo'])
    expect(next.caption_render.blacklist).toEqual(['watermark'])
  })

  test('the settings passed in are left as they were', () => {
    const before = settings(['solo'], ['long_hair'])
    withCommonTag(before, 'long hair', true, 'spaces')
    expect(before.caption_render.common_tags).toEqual(['solo'])
    expect(before.caption_render.blacklist).toEqual(['long_hair'])
  })
})

describe('the blacklist toggle', () => {
  test('blacklisting a common tag takes it off the common tags (one list at a time, as in V3.5)', () => {
    const next = withBlacklistedTag(settings(['solo', 'long hair'], []), 'long_hair', true)
    expect(next.caption_render.blacklist).toEqual(['long_hair'])
    expect(next.caption_render.common_tags).toEqual(['solo'])
  })

  test('unlisting removes it from the blacklist only', () => {
    const next = withBlacklistedTag(settings(['solo'], ['long_hair', 'watermark']), 'long hair', false)
    expect(next.caption_render.blacklist).toEqual(['watermark'])
    expect(next.caption_render.common_tags).toEqual(['solo'])
  })
})
