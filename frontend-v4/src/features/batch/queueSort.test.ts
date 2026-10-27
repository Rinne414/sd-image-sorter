import { describe, expect, test } from 'vitest'
import {
  aestheticGroup,
  arrange,
  assignByRules,
  freeName,
  groupCounts,
  newProfile,
  newRule,
  parseProfiles,
  profileGroups,
  ratingGroup,
  resolutionGroup,
  runsOf,
  SORT_GROUPS,
  UNSORTED,
  type RatingTag,
} from './queueSort'

describe('the built-in groups (classic: rating, aesthetic, resolution)', () => {
  test('rating: the most explicit tag wins, none means unrated', () => {
    const has = (...tags: RatingTag[]) => new Set<RatingTag>(tags)
    expect(ratingGroup(has('general', 'explicit'))).toBe('explicit')
    expect(ratingGroup(has('general', 'questionable'))).toBe('questionable')
    expect(ratingGroup(has('sensitive', 'general'))).toBe('sensitive')
    expect(ratingGroup(has('general'))).toBe('general')
    expect(ratingGroup(has())).toBe('unrated')
    // never tagged: every rating search finds it
    expect(ratingGroup(has('general', 'sensitive', 'questionable', 'explicit'))).toBe('unrated')
  })

  test('aesthetic: 7 and up great, 5 up to 7 good, below 5 low, no score unscored', () => {
    expect([8, 7, 6.99, 5, 4.99, 0, null, undefined].map(aestheticGroup)).toEqual(['great', 'great', 'good', 'good', 'low', 'low', 'unscored', 'unscored'])
  })

  test('resolution: the longer side from 1920 is HD, no size is unknown', () => {
    expect(resolutionGroup(1920, 800)).toBe('hd')
    expect(resolutionGroup(512, 2048)).toBe('hd')
    expect(resolutionGroup(1919, 1000)).toBe('sd')
    expect(resolutionGroup(null, null)).toBe('unknown')
    expect(resolutionGroup(0, 0)).toBe('unknown')
  })

  test('each sort lists its groups best first, the last one for the rest', () => {
    expect(SORT_GROUPS.rating.map((g) => g.id)).toEqual(['general', 'sensitive', 'questionable', 'explicit', 'unrated'])
    expect(SORT_GROUPS.aesthetic.map((g) => g.id)).toEqual(['great', 'good', 'low', 'unscored'])
    expect(SORT_GROUPS.resolution.map((g) => g.id)).toEqual(['hd', 'sd', 'unknown'])
  })
})

describe('arrange', () => {
  const groups = SORT_GROUPS.resolution
  const of = new Map([
    ['a', 'sd'],
    ['b', 'hd'],
    ['c', 'sd'],
    ['d', 'hd'],
    ['e', 'unknown'],
  ])

  test('puts groups in order and keeps the order inside each group', () => {
    expect(arrange(['a', 'b', 'c', 'd', 'e'], groups, of)).toEqual(['b', 'd', 'a', 'c', 'e'])
  })

  test('a key with no group goes to the end', () => {
    expect(arrange(['x', 'b', 'a'], groups, of)).toEqual(['b', 'a', 'x'])
  })

  test('sorting an already sorted queue changes nothing, and does not touch its input', () => {
    const order = ['b', 'd', 'a', 'c', 'e']
    const copy = [...order]
    expect(arrange(order, groups, of)).toEqual(copy)
    expect(order).toEqual(copy)
  })

  test('counts per group, empty ones included', () => {
    expect(groupCounts(groups, ['a', 'b', 'c', 'd', 'e'], of)).toEqual([2, 2, 1])
    expect(groupCounts(groups, ['a'], of)).toEqual([0, 1, 0])
  })
})

describe('runsOf', () => {
  test('cuts the queue where the group changes', () => {
    const groups = SORT_GROUPS.resolution
    const of = new Map([
      ['a', 'hd'],
      ['b', 'hd'],
      ['c', 'sd'],
      ['d', 'hd'],
    ])
    const runs = runsOf(['a', 'b', 'c', 'd'], groups, of)
    expect(runs.map((r) => [r.group?.id, r.start, r.end])).toEqual([
      ['hd', 0, 2],
      ['sd', 2, 3],
      ['hd', 3, 4],
    ])
  })

  test('with no sort shown it is one run without a group', () => {
    expect(runsOf(['a', 'b'], null, new Map())).toEqual([{ group: null, start: 0, end: 2 }])
    expect(runsOf([], null, new Map())).toEqual([])
  })
})

describe('profiles', () => {
  test('the first rule an image matches takes it, the rest are unsorted', () => {
    const rules = [newRule(0, 'Girls'), newRule(1, 'Boys')]
    const matching = [new Set(['a', 'b']), new Set(['b', 'c'])]
    const of = assignByRules(['a', 'b', 'c', 'd'], rules, matching)
    expect(of.get('a')).toBe(rules[0]?.id)
    expect(of.get('b')).toBe(rules[0]?.id)
    expect(of.get('c')).toBe(rules[1]?.id)
    expect(of.get('d')).toBe(UNSORTED)
  })

  test('a profile makes one group per rule and an unsorted one last', () => {
    const profile = newProfile('Mine', newRule(0, 'First'))
    const groups = profileGroups({ ...profile, rules: [...profile.rules, newRule(1, 'Second')] })
    expect(groups.map((g) => ('text' in g.name ? g.name.text : g.id))).toEqual(['First', 'Second', UNSORTED])
  })

  test('reads stored profiles and leaves out what is not one', () => {
    const raw = JSON.stringify([
      { id: 'p1', name: ' Mine ', rules: [{ id: 'r1', name: 'A', tone: 'red', condition: 'tag:cat' }, { name: 'B', tone: 'nope' }, 7] },
      { name: '' },
      'x',
    ])
    const list = parseProfiles(raw)
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('Mine')
    expect(list[0]?.rules.map((r) => [r.name, r.tone, r.condition])).toEqual([
      ['A', 'red', 'tag:cat'],
      ['B', 'green', ''],
    ])
    expect(parseProfiles('{nope')).toEqual([])
    expect(parseProfiles(null)).toEqual([])
  })

  test('a name already taken gets a number', () => {
    expect(freeName('Mine', [])).toBe('Mine')
    expect(freeName('Mine', ['mine'])).toBe('Mine 2')
    expect(freeName('Mine', ['Mine', 'Mine 2'])).toBe('Mine 3')
  })
})
