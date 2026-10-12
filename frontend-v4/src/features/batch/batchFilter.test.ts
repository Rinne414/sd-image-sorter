import { describe, expect, it } from 'vitest'
import { byName, matchKeys, outsideLibrary, shownKeys, visibleMatches } from './batchFilter'

const entries = [
  { key: 'l:1', filename: 'Cover_final.png', imageId: 1 },
  { key: 'l:2', filename: 'page02.png', imageId: 2 },
  { key: 'f:a', filename: 'cover-alt.jpg', imageId: null },
]

describe('the batch name filter', () => {
  it('keeps the images whose file name contains the text, any case', () => {
    expect(byName(entries, 'COVER').map((e) => e.key)).toEqual(['l:1', 'f:a'])
    expect(byName(entries, '  page ').map((e) => e.key)).toEqual(['l:2'])
  })

  it('shows everything for an empty text, and names no shown set then', () => {
    expect(byName(entries, '   ')).toBe(entries)
    expect(shownKeys(entries, '')).toBeNull()
    expect([...(shownKeys(entries, 'cover') ?? [])]).toEqual(['l:1', 'f:a'])
  })
})

describe('the batch condition', () => {
  it('matches only the batch images the library search returned', () => {
    expect([...matchKeys(entries, [2, 9, 1])]).toEqual(['l:1', 'l:2'])
    expect(matchKeys(entries, []).size).toBe(0)
  })
})

describe('what a condition can and does select', () => {
  it('counts the images outside the library, which no condition applies to', () => {
    expect(outsideLibrary(entries)).toBe(1)
  })

  it('selects exactly the matches the name filter still shows', () => {
    const matches = new Set(['l:1', 'l:2'])
    expect(visibleMatches(matches, null)).toBe(matches)
    expect([...visibleMatches(matches, new Set(['l:1', 'f:a']))]).toEqual(['l:1'])
  })
})
