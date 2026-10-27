import { describe, expect, test } from 'vitest'
import classicScript from '../../../../frontend/js/tag-power.js?raw'
import { META_TAGS, missingFrom, QUALITY_TAGS, withPreset } from './blacklistPresets'

/** The tag names inside one `const NAME = [ ... ];` of the classic page's script. */
function classicList(source: string, name: string): string[] {
  const body = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(source)?.[1] ?? ''
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] as string)
}

describe('the presets match the classic page', () => {
  const source = classicScript
  test('quality', () => expect([...QUALITY_TAGS]).toEqual(classicList(source, 'QUALITY_TAGS')))
  test('meta', () => expect([...META_TAGS]).toEqual(classicList(source, 'META_TAGS')))
})

describe('withPreset', () => {
  test('adds the list to an empty box, spaces for underscores, score_ kept', () => {
    const text = withPreset('', 'quality')
    expect(text.startsWith('masterpiece, best quality, good quality')).toBe(true)
    expect(text).toContain('score_9_up')
    expect(text).not.toContain('best_quality')
  })

  test('keeps what is there and never adds a tag twice, whatever its spelling', () => {
    const text = withPreset('watermark, Jpeg_Artifacts\nmy tag', 'meta')
    const tags = text.split(', ')
    expect(tags.slice(0, 3)).toEqual(['watermark', 'Jpeg_Artifacts', 'my tag'])
    expect(tags.filter((t) => t.toLowerCase().replace(/_/g, ' ') === 'jpeg artifacts')).toHaveLength(1)
    expect(tags).toContain('signature')
  })

  test('pressing a preset twice changes nothing the second time', () => {
    const once = withPreset('', 'meta')
    expect(withPreset(once, 'meta')).toBe(once)
    expect(missingFrom(once, 'meta')).toBe(0)
  })

  test('the two lists can be added one after the other', () => {
    const both = withPreset(withPreset('', 'quality'), 'meta')
    expect(both.split(', ')).toHaveLength(QUALITY_TAGS.length + META_TAGS.length)
  })
})
