import { describe, expect, it } from 'vitest'
import { generateBody } from './generateBody'

describe('generateBody', () => {
  const setup = {
    slots: { character: ['1girl'], outfit: [], pose: ['standing', 'sitting'] },
    weights: { character: 80 },
    locked: { pose: true },
  }

  it('sends the seed, one prompt, the quality words, the negative switch and the tag sets', () => {
    const body = generateBody(setup, { quality: 'medium', negative: false, tagSets: ['builtin-tag-set:kimono', '12'] }, 4242)
    expect(body).toMatchObject({
      seed: 4242,
      count: 1,
      quality_preset: 'medium',
      include_negative: false,
      tag_sets: ['builtin-tag-set:kimono', '12'],
      count_tag: '',
    })
  })

  it('sends only filled slots, with their weight as 0-1 and their lock', () => {
    const body = generateBody(setup, { quality: 'none', negative: true, tagSets: [] }, 1)
    expect(body.categories).toEqual({
      character: { tags: ['1girl'], weight: 0.8, locked: false },
      pose: { tags: ['standing', 'sitting'], weight: 0.5, locked: true },
    })
    expect(body.quality_preset).toBe('none')
    expect(body.include_negative).toBe(true)
  })
})
