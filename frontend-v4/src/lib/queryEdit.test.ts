import { describe, expect, test } from 'vitest'
import { isAnyOf, isKey, replaceTokens, toggleToken, valueOf } from './queryEdit'
import { parseSearch } from './searchQuery'

describe('query editing', () => {
  test('replace one filter, keep everything else in order', () => {
    expect(replaceTokens('silver ★3 tag:smile', isKey('stars'), ['★5'])).toBe('silver tag:smile ★5')
    expect(replaceTokens('silver 星级>=2', isKey('stars'), [])).toBe('silver')
  })

  test('only the matching value goes: no:caption survives clearing no:params', () => {
    const text = 'no:params no:caption'
    const next = replaceTokens(text, isAnyOf(isKey('has', 'params'), isKey('no', 'params')), ['has:params'])
    expect(next).toBe('no:caption has:params')
  })

  test('toggle adds when absent and removes when present, aliases included', () => {
    expect(toggleToken('a', isKey('rating', 'general'), 'rating:general')).toBe('a rating:general')
    expect(toggleToken('a 分级:普通', isKey('rating', 'general'), 'rating:general')).toBe('a')
  })

  test('valueOf reads what the panel should show', () => {
    expect(valueOf(parseSearch('aspect:竖图').parts, 'aspect')).toBe('portrait')
    expect(valueOf(parseSearch('x').parts, 'aspect')).toBeNull()
  })
})
