import { describe, expect, it } from 'vitest'
import { parseSearch, toImageParams } from './searchQuery'
import { usesColorFilter } from './colorFilter'

const params = (query: string) => toImageParams(parseSearch(query), { generators: [], folder: null, favoritesCollectionId: null }, 'newest')

describe('filters that only see images with colour analysis', () => {
  it('are the colour, tone, brightness and saturation filters', () => {
    for (const q of ['color:red', '-color:blue', 'color:warm', 'light:balanced', 'brightness>=100', 'sat<=40']) expect(usesColorFilter(params(q)), q).toBe(true)
  })

  it('are not the other filters', () => {
    for (const q of ['', 'tag:cat', 'score>=6', 'width>=1024']) expect(usesColorFilter(params(q)), q).toBe(false)
  })
})
