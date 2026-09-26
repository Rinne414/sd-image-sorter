import { describe, expect, it } from 'vitest'
import { EMPTY_SETUP, readSetup, setupConfig } from './setup'

describe('presets', () => {
  it('a V3.5 preset loads: slots, weights, locks and fixed words; the rest keeps its defaults', () => {
    const v35 = { slots: { outfit: ['dress'], pose: [] }, weights: { outfit: 80 }, locked: { outfit: true }, prependTags: 'masterpiece', appendTags: 'night_sky' }
    expect(readSetup(v35)).toEqual({
      ...EMPTY_SETUP,
      slots: { outfit: ['dress'], pose: [] },
      weights: { outfit: 80 },
      locked: { outfit: true },
      prepend: 'masterpiece',
      append: 'night_sky',
    })
  })

  it('a V4 setup saves under V3.5’s keys and comes back the same', () => {
    const setup = { ...EMPTY_SETUP, slots: { character: ['1girl'] }, weights: { character: 30 }, locked: {}, tagSets: ['builtin-tag-set:witch', '7'], quality: 'medium' as const, negative: false, count: 4, seed: '99' }
    const config = setupConfig(setup)
    expect(config).toMatchObject({ slots: setup.slots, prependTags: '', appendTags: '' })
    expect(readSetup(JSON.parse(JSON.stringify(config)))).toEqual(setup)
  })

  it('ignores what does not fit instead of breaking', () => {
    expect(readSetup({ slots: 'x', weights: { a: 500, b: 'x' }, locked: { a: 'yes' }, count: -2, quality: 'ultra' })).toEqual(EMPTY_SETUP)
    expect(readSetup(null)).toEqual(EMPTY_SETUP)
  })
})
