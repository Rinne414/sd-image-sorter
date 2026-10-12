import { describe, expect, it } from 'vitest'
import { conflictsBySlot, drawSlots, placeTags, rng, seedsFor, parseSeed, toggleTag, withAffixes, type Rule } from './slots'

const POOL = {
  character: ['1girl', '1boy', 'solo', 'multiple_girls'],
  outfit: ['dress', 'school_uniform', 'kimono', 'swimsuit', 'bikini', 'hoodie'],
  pose: ['standing', 'sitting', 'lying', 'kneeling'],
  background: ['night_sky', 'beach', 'classroom'],
  meta: ['highres', 'absurdres'],
  unknown: ['mystery'],
}

const setup = (over: Partial<Parameters<typeof drawSlots>[1]> = {}) => ({ slots: {}, weights: {}, locked: {}, ...over })

describe('rng', () => {
  it('gives the same numbers for the same seed', () => {
    const a = rng(42)
    const b = rng(42)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
    const c = rng(43)
    expect(c()).not.toBe(rng(42)())
  })
})

describe('drawSlots', () => {
  it('the same seed draws the same slots; another seed draws others', () => {
    const one = drawSlots(POOL, setup({ weights: { character: 100, outfit: 100, pose: 100, background: 100 } }), 7)
    const two = drawSlots(POOL, setup({ weights: { character: 100, outfit: 100, pose: 100, background: 100 } }), 7)
    expect(one).toEqual(two)
    const seeds = [8, 9, 10, 11].map((s) => JSON.stringify(drawSlots(POOL, setup({ weights: { outfit: 100 } }), s)))
    expect(new Set([JSON.stringify(one), ...seeds]).size).toBeGreaterThan(1)
  })

  it('draws one to three tags from each category, never twice the same', () => {
    const slots = drawSlots(POOL, setup({ weights: { character: 100, outfit: 100, pose: 100, background: 100 } }), 3)
    for (const cat of ['character', 'outfit', 'pose', 'background']) {
      const tags = slots[cat] ?? []
      expect(tags.length).toBeGreaterThanOrEqual(1)
      expect(tags.length).toBeLessThanOrEqual(3)
      expect(new Set(tags).size).toBe(tags.length)
      for (const tag of tags) expect(POOL[cat as keyof typeof POOL]).toContain(tag)
    }
  })

  it('a locked slot survives the draw exactly as it was', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const slots = drawSlots(POOL, setup({ slots: { outfit: ['my own outfit'] }, locked: { outfit: true }, weights: { outfit: 100 } }), seed)
      expect(slots.outfit).toEqual(['my own outfit'])
    }
  })

  it('weight 0 leaves a category out; meta, rating and unclassified are never drawn', () => {
    const weights = { character: 0, outfit: 0, pose: 0, background: 100, meta: 100, unknown: 100 }
    for (const seed of [11, 12, 13]) {
      const slots = drawSlots(POOL, setup({ weights, slots: { pose: ['old pose'] } }), seed)
      expect(slots.character ?? []).toEqual([])
      expect(slots.pose ?? []).toEqual([])
      expect(slots.meta ?? []).toEqual([])
      expect(slots.unknown ?? []).toEqual([])
      expect((slots.background ?? []).length).toBeGreaterThan(0)
    }
  })

  it('never comes back empty: with every weight at 0 one tag is still drawn', () => {
    const slots = drawSlots(POOL, setup({ weights: { character: 0, outfit: 0, pose: 0, background: 0 } }), 5)
    expect(Object.values(slots).flat()).toHaveLength(1)
  })

  it('an exclusion rule drops what it forbids from a drawn slot, but never from a locked one', () => {
    const rules: Rule[] = [{ id: 1, name: 'no sitting when standing', conditions: [{ tag: 'standing', type: 'present' }], targets: [{ tag: 'sitting', category: '' }] }]
    const locked = setup({ slots: { character: ['standing'] }, locked: { character: true }, weights: { pose: 100, outfit: 0, background: 0 } })
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) expect(drawSlots(POOL, locked, seed, rules).pose ?? []).not.toContain('sitting')
    const mine = setup({ slots: { character: ['standing'], pose: ['sitting'] }, locked: { character: true, pose: true }, weights: { outfit: 0, background: 0 } })
    expect(drawSlots(POOL, mine, 1, rules).pose).toEqual(['sitting'])
  })
})

describe('conflictsBySlot', () => {
  it('names the rule, what set it off and the tag that clashes, ignoring case and _', () => {
    const rules: Rule[] = [{ id: 'builtin', name: 'nude_excludes_outfit', conditions: [{ tag: 'nude', type: 'present' }], targets: [{ tag: 'school_uniform', category: '' }] }]
    expect(conflictsBySlot({ character: ['Nude'], outfit: ['school uniform', 'hat'] }, rules)).toEqual({
      outfit: [{ rule: 'nude_excludes_outfit', when: ['nude'], tag: 'school uniform' }],
    })
    expect(conflictsBySlot({ outfit: ['school uniform'] }, rules)).toEqual({})
  })
})

describe('withAffixes', () => {
  it('puts the fixed words first and last, each once (case, spaces and _ ignored)', () => {
    expect(withAffixes('best_quality, 1girl, smile', 'masterpiece, Best Quality', 'smile, night_sky')).toBe('masterpiece, Best Quality, 1girl, smile, night_sky')
  })

  it('leaves the prompt alone when there are no fixed words', () => {
    expect(withAffixes('a, b', '', ' ')).toBe('a, b')
  })
})

describe('slot edits', () => {
  it('clicking a tag adds it to its category and clicking again takes it out', () => {
    const one = toggleTag({}, 'pose', 'standing')
    expect(one).toEqual({ pose: ['standing'] })
    expect(toggleTag(one, 'pose', 'standing')).toEqual({ pose: [] })
  })

  it('places words into the slot of their category, each once', () => {
    const { slots, added } = placeTags({ pose: ['standing'] }, [
      { tag: 'standing', category: 'pose' },
      { tag: 'dress', category: 'outfit' },
      { tag: 'odd', category: 'unknown' },
    ])
    expect(slots).toEqual({ pose: ['standing'], outfit: ['dress'], unknown: ['odd'] })
    expect(added).toBe(2)
  })
})

describe('seeds', () => {
  it('a typed seed is a whole number from 0 up; anything else means a new one each time', () => {
    expect(parseSeed('42')).toBe(42)
    expect(parseSeed(' 7 ')).toBe(7)
    expect(parseSeed('')).toBeNull()
    expect(parseSeed('-1')).toBeNull()
    expect(parseSeed('1.5')).toBeNull()
    expect(parseSeed('abc')).toBeNull()
  })

  it('several prompts use seed, seed + 1, … like the backend', () => {
    expect(seedsFor(100, 3)).toEqual([100, 101, 102])
  })
})
