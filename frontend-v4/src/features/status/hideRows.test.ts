import { beforeEach, describe, expect, test } from 'vitest'
import { stillHidden, useRowHides } from './hideRows'

describe('hiding the unreadable files line', () => {
  test('stays hidden only while the number is the one that was hidden', () => {
    expect(stillHidden(null, 4)).toBe(false)
    expect(stillHidden(4, 4)).toBe(true)
    expect(stillHidden(4, 5)).toBe(false)
    expect(stillHidden(4, 3)).toBe(false)
  })

  test('nothing unreadable means nothing to hide', () => {
    expect(stillHidden(0, 0)).toBe(false)
  })
})

describe('the hide store', () => {
  beforeEach(() => {
    useRowHides.setState({ unreadableAt: null, colorsJobId: null })
  })

  test('remembers the number hidden and forgets it when shown again', () => {
    useRowHides.getState().hideUnreadable(7)
    expect(useRowHides.getState().unreadableAt).toBe(7)
    useRowHides.getState().showUnreadable()
    expect(useRowHides.getState().unreadableAt).toBeNull()
  })

  test('remembers which colour run was hidden', () => {
    useRowHides.getState().hideColors('colors-3')
    expect(useRowHides.getState().colorsJobId).toBe('colors-3')
  })
})
