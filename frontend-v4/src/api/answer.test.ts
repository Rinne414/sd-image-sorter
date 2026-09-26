import { describe, expect, test } from 'vitest'
import { checkAnswer } from './answer'

interface Listing {
  current: string
  subdirs: unknown[]
}

const isListing = (a: Record<string, unknown>) => typeof a.current === 'string' && Array.isArray(a.subdirs)

describe('an answer whose fields are read', () => {
  test('empty, {} or without the fields read: refused with the reason, never a script error later', () => {
    for (const raw of [undefined, null, '', 'text', 0, [], {}, { current: 'D:\\' }, { current: 1, subdirs: [] }, { subdirs: null, current: '' }]) {
      expect(() => checkAnswer<Listing>(raw, isListing, 'the answer was incomplete'), JSON.stringify(raw)).toThrow('the answer was incomplete')
    }
  })

  test('an answer with them comes back as it is', () => {
    const raw = { current: 'D:\\art', parent: 'D:\\', subdirs: [{ name: 'keep' }] }
    expect(checkAnswer<Listing>(raw, isListing, 'x')).toBe(raw)
  })
})
