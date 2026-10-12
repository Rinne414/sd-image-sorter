import { describe, expect, it } from 'vitest'
import { EMPTY_RULE } from './rules'
import { addRule, allRules, assignRules, groupsBody, removeRule, rulesReady, setRule } from './ruleSet'
import { cleanSetup, EMPTY_SETUP } from './savedSetup'

// Sort by condition with several rules (V3.5's auto-sort profiles): each rule
// is a condition and a folder; an image goes to the FIRST rule it matches, in
// the order shown, and an image no rule matches stays where it is.

const rule = (query: string, destination: string | null = `D:/${query || 'all'}`) => ({ ...EMPTY_RULE, query, destination })

describe('which images each rule takes', () => {
  it('gives an image to the first rule it matches (V3.5: a matched image leaves the pool)', () => {
    const { groups } = assignRules([[1, 2, 3], [2, 3, 4], [4, 5]], null)
    expect(groups).toEqual([[1, 2, 3], [4], [5]])
  })

  it('keeps to the picks when the picks are the pool, and counts the ones no rule took', () => {
    const { groups, left } = assignRules([[1, 9], [2, 3]], [1, 2, 3, 4])
    expect(groups).toEqual([[1], [2, 3]])
    expect(left).toBe(1)
  })

  it('takes the same image once even when a rule lists it twice', () => {
    expect(assignRules([[1, 1, 2]], null).groups).toEqual([[1, 2]])
  })

  it('leaves its input alone', () => {
    const matched = [[1, 2], [2]]
    assignRules(matched, null)
    expect(matched).toEqual([[1, 2], [2]])
  })
})

describe('the one run that sorts every rule', () => {
  it('sends each rule its images, folder and split, leaving out rules that took none', () => {
    const body = groupsBody(
      [
        { ids: [3, 1], rule: rule('a') },
        { ids: [], rule: rule('b') },
        { ids: [7], rule: { ...rule('c'), splitBy: 'rating' } },
      ],
      'copy',
    )
    expect(body).toMatchObject({ image_ids: [3, 1, 7], destination_folder: 'D:/a', operation: 'copy', split_by: null })
    expect(body.groups).toEqual([
      { image_ids: [3, 1], destination_folder: 'D:/a', split_by: null },
      { image_ids: [7], destination_folder: 'D:/c', split_by: 'rating' },
    ])
  })
})

describe('the rules of a setup', () => {
  const base = { ...EMPTY_SETUP, mode: 'rules' as const, rule: rule('gen:nai') }

  it('lists the first rule, then the ones added under it', () => {
    const two = addRule(base)
    expect(allRules(two)).toEqual([base.rule, EMPTY_RULE])
    expect(base.more).toEqual([])
  })

  it('changes and removes an added rule by its place, never the first', () => {
    const three = addRule(addRule(base))
    const changed = setRule(three, 2, rule('score>=7'))
    expect(allRules(changed).map((r) => r.query)).toEqual(['gen:nai', '', 'score>=7'])
    expect(allRules(removeRule(changed, 1)).map((r) => r.query)).toEqual(['gen:nai', 'score>=7'])
    expect(removeRule(changed, 0)).toBe(changed)
  })

  it('is ready only when every rule has its folder', () => {
    expect(rulesReady(base)).toBe(true)
    expect(rulesReady(addRule(base))).toBe(false)
    expect(rulesReady(setRule(addRule(base), 1, rule('score>=7')))).toBe(true)
  })

  it('reads an old one-condition setup or preset as one rule, and keeps added rules safe', () => {
    expect(cleanSetup({ mode: 'rules', rule: { query: 'gen:nai', destination: 'D:/x', splitBy: 'none' } }).more).toEqual([])
    const stored = { mode: 'rules', rule: rule('a'), more: [rule('b'), 'junk', { query: 'c', destination: ' ', splitBy: 'moon' }] }
    expect(cleanSetup(stored).more).toEqual([rule('b'), { query: 'c', destination: null, splitBy: 'none' }])
  })
})
