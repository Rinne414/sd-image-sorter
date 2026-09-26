import { describe, expect, test } from 'vitest'
import { format } from './index'

describe('an English count of 1 reads in the singular', () => {
  test('the noun after the count', () => {
    expect(format('Identify {n} images', { n: 1 })).toBe('Identify 1 image')
    expect(format('Identify {n} images', { n: 2 })).toBe('Identify 2 images')
    expect(format('Identify {n} images', { n: 0 })).toBe('Identify 0 images')
    expect(format('{n} categories and {m} tags', { n: 1, m: 1 })).toBe('1 category and 1 tag')
  })

  test('with one modifier between the count and the noun', () => {
    expect(format('{n} folder images got their results', { n: 1 })).toBe('1 folder image got their results')
    expect(format('{n} more pairs', { n: 1 })).toBe('1 more pair')
  })

  test('and the verb right after it', () => {
    expect(format('{n} images are too small', { n: 1 })).toBe('1 image is too small')
    expect(format('{n} images have no rating tag', { n: 1 })).toBe('1 image has no rating tag')
    expect(format('{n} captions were just changed elsewhere', { n: 1 })).toBe('1 caption was just changed elsewhere')
    expect(format('{n} already have tags', { n: 1 })).toBe('1 already has tags')
    expect(format('{n} more are not listed.', { n: 1 })).toBe('1 more is not listed.')
    expect(format('{n} images are too small', { n: 3 })).toBe('3 images are too small')
    expect(format('Tag the {n} that already have tags', { n: 1 })).toBe('Tag the 1 that already has tags')
    expect(format('Also show the {n} that are the same', { n: 1 })).toBe('Also show the 1 that is the same')
    expect(format('{n} images look like another character', { n: 1 })).toBe('1 image looks like another character')
    expect(format('{n} match', { n: 1 })).toBe('1 matches')
  })

  test('a count given as text counts too; anything else is left alone', () => {
    expect(format('{n} images', { n: '1' })).toBe('1 image')
    expect(format('{name} images', { name: 'Two' })).toBe('Two images')
    expect(format('{n} of them have tags', { n: 1 })).toBe('1 of them have tags')
    expect(format('识别 {n} 张', { n: 1 })).toBe('识别 1 张')
  })
})
