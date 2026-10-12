import { beforeEach, describe, expect, it } from 'vitest'
import { picksFrom, seedPicks, setPick, swapPicks, useComparePicks } from './labStore'

describe('Compare starts from the library', () => {
  beforeEach(() => useComparePicks.setState({ a: null, b: null, fromSelection: 0 }))

  it('uses the first two picked images, in the order they were picked', () => {
    expect(picksFrom([7, 3, 9], 5)).toEqual({ a: 7, b: 3, fromSelection: 3 })
  })

  it('with one pick or none, A is the pick or the image being looked at', () => {
    expect(picksFrom([4], 5)).toEqual({ a: 4, b: null, fromSelection: 0 })
    expect(picksFrom([], 5)).toEqual({ a: 5, b: null, fromSelection: 0 })
    expect(picksFrom([], null)).toEqual({ a: null, b: null, fromSelection: 0 })
  })

  it('does not replace images the user already chose', () => {
    setPick('a', 11)
    seedPicks([1, 2], null)
    expect(useComparePicks.getState()).toMatchObject({ a: 11, b: null })
  })

  it('swaps A and B', () => {
    seedPicks([1, 2], null)
    swapPicks()
    expect(useComparePicks.getState()).toMatchObject({ a: 2, b: 1 })
  })
})
