import { describe, expect, it } from 'vitest'
import { firstFocusable } from './dialogFocus'

describe("a dialog's first focus", () => {
  it('skips the header close button (tabIndex -1) and lands on the first real control', () => {
    const close = { tabIndex: -1, id: 'close' }
    const input = { tabIndex: 0, id: 'input' }
    expect(firstFocusable([close, input])).toBe(input)
    expect(firstFocusable([close])).toBeNull()
  })
})
