import { describe, expect, it } from 'vitest'
import { shownTotal, totalIsEstimate } from './resultTotal'

describe('the result count the library shows', () => {
  it('is an estimate only for whole-word prompt terms (the backend counts before it checks the words)', () => {
    expect(totalIsEstimate({ prompts: 'blue eyes' })).toBe(true)
    expect(totalIsEstimate({ prompts: 'blue eyes', prompt_match_mode: 'exact' })).toBe(true)
    expect(totalIsEstimate({ prompts: 'blue eyes', prompt_match_mode: 'contains' })).toBe(false)
    expect(totalIsEstimate({ tags: 'cat_ears', search: 'x' })).toBe(false)
    expect(totalIsEstimate({ exclude_prompts: 'blue eyes' })).toBe(false)
  })

  it('an exact total is shown as it is', () => {
    expect(shownTotal(60, false, 60, false)).toEqual({ n: 60, about: false })
    expect(shownTotal(300, false, 240, true)).toEqual({ n: 300, about: false })
  })

  it('an estimate with every page here: the images themselves are the exact count', () => {
    expect(shownTotal(60, true, 30, false)).toEqual({ n: 30, about: false })
  })

  it('an estimate with more pages to come stays "about N"', () => {
    expect(shownTotal(300, true, 240, true)).toEqual({ n: 300, about: true })
  })

  it('nothing to show while there is no total', () => {
    expect(shownTotal(null, true, 0, false)).toBeNull()
  })
})
