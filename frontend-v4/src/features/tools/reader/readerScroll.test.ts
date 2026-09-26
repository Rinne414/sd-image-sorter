import { describe, expect, it } from 'vitest'
import { restoredTop, snapshotOf } from './readerScroll'

describe("the Reader's info column keeps its place on the next image (V3.5's rule)", () => {
  it('remembers the position and how far down it is', () => {
    expect(snapshotOf(300, 1300, 700)).toEqual({ top: 300, ratio: 0.5 })
    expect(snapshotOf(0, 500, 700)).toEqual({ top: 0, ratio: 0 })
  })

  it('goes back to the same place, or as far down proportionally when the next one is longer', () => {
    expect(restoredTop({ top: 300, ratio: 0.5 }, 1300, 700)).toBe(300)
    expect(restoredTop({ top: 300, ratio: 0.5 }, 2700, 700)).toBe(1000)
  })

  it('stops at the end of a shorter one, and does nothing when nothing scrolls', () => {
    expect(restoredTop({ top: 900, ratio: 0.9 }, 1000, 700)).toBe(300)
    expect(restoredTop({ top: 300, ratio: 0.5 }, 600, 700)).toBeNull()
  })
})
