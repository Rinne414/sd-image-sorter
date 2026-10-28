import { describe, expect, test } from 'vitest'
import { pickFitting } from './fittingPlaceholder'

// one unit of width per character
const widthOf = (text: string) => text.length

describe('pickFitting', () => {
  const candidates = ['Search prompts or filenames, or use tag:x', 'Search prompts or filenames', 'Search']

  test('the longest one that fits', () => {
    expect(pickFitting(candidates, widthOf, 100)).toBe(candidates[0])
    expect(pickFitting(candidates, widthOf, 30)).toBe('Search prompts or filenames')
  })

  test('the shortest one when none fits', () => {
    expect(pickFitting(candidates, widthOf, 3)).toBe('Search')
  })

  test('nothing to pick from gives an empty placeholder', () => {
    expect(pickFitting([], widthOf, 100)).toBe('')
  })
})
