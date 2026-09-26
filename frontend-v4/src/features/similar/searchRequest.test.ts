import { describe, expect, it } from 'vitest'
import { DEFAULT_THRESHOLD, hitFloor, nearQuery, textBody, uploadSearch, usesThreshold, type SearchOptions } from './searchRequest'

const whole: SearchOptions = { threshold: DEFAULT_THRESHOLD, collectionId: null }
const favorites: SearchOptions = { threshold: 0.7, collectionId: 12 }

describe('what a similarity search sends', () => {
  it('starts at V3.5\'s 50 % over the whole library', () => {
    expect(DEFAULT_THRESHOLD).toBe(0.5)
  })

  it('by file: the threshold and the collection go with the request', () => {
    expect(new URLSearchParams(uploadSearch(100, 200, favorites))).toEqual(
      new URLSearchParams({ limit: '100', offset: '200', threshold: '0.7', collection_id: '12' }),
    )
    expect(new URLSearchParams(uploadSearch(100, 0, whole)).has('collection_id')).toBe(false)
    expect(new URLSearchParams(uploadSearch(100, 0, whole)).get('threshold')).toBe('0.5')
  })

  it('by meaning: the collection goes with it, the threshold does not (a sentence is ranked top-k, as in V3.5)', () => {
    expect(textBody('red dress', 100, 0, favorites)).toEqual({ query: 'red dress', limit: 100, offset: 0, threshold: 0, collection_id: 12 })
    expect(textBody('red dress', 100, 100, whole)).toEqual({ query: 'red dress', limit: 100, offset: 100, threshold: 0 })
  })

  it('like an image of the library: the collection goes with the request, the threshold filters the scores', () => {
    expect(nearQuery(200, favorites)).toEqual({ limit: 200, collection_id: 12 })
    expect(nearQuery(200, whole)).toEqual({ limit: 200 })
    expect(hitFloor({ kind: 'image', id: 1, name: 'a', near: false }, favorites)).toBe(0.7)
  })

  it('near-duplicates keep their own 90 % floor, whatever the threshold', () => {
    expect(hitFloor({ kind: 'image', id: 1, name: 'a', near: true }, { threshold: 0.3, collectionId: null })).toBe(0.9)
    expect(hitFloor({ kind: 'image', id: 1, name: 'a', near: true }, { threshold: 0.95, collectionId: null })).toBe(0.9)
  })

  it('the threshold shows only where it applies', () => {
    expect(usesThreshold({ kind: 'image', id: 1, name: 'a', near: false })).toBe(true)
    expect(usesThreshold({ kind: 'upload', file: new File([], 'x.png'), token: 1 })).toBe(true)
    expect(usesThreshold({ kind: 'image', id: 1, name: 'a', near: true })).toBe(false)
    expect(usesThreshold({ kind: 'text', text: 'x' })).toBe(false)
    // the server applies it to files; nothing more is cut here
    expect(hitFloor({ kind: 'upload', file: new File([], 'x.png'), token: 1 }, favorites)).toBe(0)
    expect(hitFloor({ kind: 'text', text: 'x' }, favorites)).toBe(0)
  })
})
