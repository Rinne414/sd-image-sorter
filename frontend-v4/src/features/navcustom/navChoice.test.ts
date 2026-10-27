import { describe, expect, test } from 'vitest'
import { defaultChoice, hiddenIds, isDefaultChoice, moveBy, moveTo, normalizeChoice, parseChoice, setShown, shownIds, type NavDef } from './navChoice'

const DEFS: NavDef[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd', shown: false }]

describe('default choice', () => {
  test('keeps the list order and hides the places that default to hidden', () => {
    const c = defaultChoice(DEFS)
    expect(c.order).toEqual(['a', 'b', 'c', 'd'])
    expect(shownIds(c)).toEqual(['a', 'b', 'c'])
    expect(hiddenIds(c)).toEqual(['d'])
    expect(isDefaultChoice(c, DEFS)).toBe(true)
  })
})

describe('normalize and parse', () => {
  test('drops unknown and repeated ids, appends places added later by their default', () => {
    const c = normalizeChoice({ order: ['c', 'zzz', 'a', 'c'], hidden: ['a', 'nope'] }, DEFS)
    expect(c.order).toEqual(['c', 'a', 'b', 'd'])
    expect(c.hidden).toEqual(['a', 'd'])
  })
  test('hiding everything leaves the first place in the bar', () => {
    const c = normalizeChoice({ order: ['b', 'a', 'c', 'd'], hidden: ['a', 'b', 'c', 'd'] }, DEFS)
    expect(shownIds(c)).toEqual(['b'])
  })
  test('garbage becomes the default', () => {
    expect(parseChoice('{not json', DEFS)).toEqual(defaultChoice(DEFS))
    expect(parseChoice(null, DEFS)).toEqual(defaultChoice(DEFS))
    expect(parseChoice('42', DEFS)).toEqual(defaultChoice(DEFS))
    expect(parseChoice('{"order":"x","hidden":7}', DEFS)).toEqual(defaultChoice(DEFS))
  })
})

describe('showing and hiding', () => {
  test('hides and shows a place without losing its slot', () => {
    const hidden = setShown(defaultChoice(DEFS), 'b', false)
    expect(hidden.refused).toBe(false)
    expect(shownIds(hidden.choice)).toEqual(['a', 'c'])
    expect(shownIds(setShown(hidden.choice, 'b', true).choice)).toEqual(['a', 'b', 'c'])
  })
  test('refuses to hide the last place in the bar', () => {
    let c = defaultChoice(DEFS)
    c = setShown(c, 'a', false).choice
    c = setShown(c, 'b', false).choice
    const last = setShown(c, 'c', false)
    expect(last.refused).toBe(true)
    expect(shownIds(last.choice)).toEqual(['c'])
  })
  test('hiding a hidden place or an unknown one is not a refusal', () => {
    expect(setShown(defaultChoice(DEFS), 'd', false).refused).toBe(false)
    expect(setShown(defaultChoice(DEFS), 'x', false).refused).toBe(false)
  })
})

describe('moving', () => {
  test('up and down swap neighbours; the ends stay put', () => {
    const c = defaultChoice(DEFS)
    expect(moveBy(c, 'b', -1).order).toEqual(['b', 'a', 'c', 'd'])
    expect(moveBy(c, 'b', 1).order).toEqual(['a', 'c', 'b', 'd'])
    expect(moveBy(c, 'a', -1)).toBe(c)
    expect(moveBy(c, 'd', 1)).toBe(c)
  })
  test('moveTo puts a place at an index (drag and drop)', () => {
    const c = defaultChoice(DEFS)
    expect(moveTo(c, 'a', 2).order).toEqual(['b', 'c', 'a', 'd'])
    expect(moveTo(c, 'd', 0).order).toEqual(['d', 'a', 'b', 'c'])
    expect(moveTo(c, 'd', 99)).toBe(c)
    expect(moveTo(c, 'x', 1)).toBe(c)
  })
  test('a changed order is not the default', () => {
    expect(isDefaultChoice(moveBy(defaultChoice(DEFS), 'a', 1), DEFS)).toBe(false)
  })
})
