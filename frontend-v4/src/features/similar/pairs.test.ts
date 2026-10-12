import { describe, expect, it } from 'vitest'
import { PAIR_DEFAULT, PAIR_PAGE, pairQuery, readPairs, warnsLow, withoutGone } from './pairs'

describe('similar pairs (V3.5\'s pair finder)', () => {
  it('asks GET /api/similarity/duplicates with the threshold, a page of 500 and the offset', () => {
    expect(PAIR_DEFAULT).toBe(0.95)
    expect(pairQuery(0.6, 0)).toEqual({ threshold: 0.6, limit: PAIR_PAGE, offset: 0 })
    expect(pairQuery(0.95, 500)).toEqual({ threshold: 0.95, limit: 500, offset: 500 })
    // the endpoint's own range, 50-99 %
    expect(pairQuery(0.2, 0).threshold).toBe(0.5)
    expect(pairQuery(1, 0).threshold).toBe(0.99)
    expect(pairQuery(0.6000000001, 0).threshold).toBe(0.6)
  })

  it('warns below 90 %, never blocks', () => {
    expect(warnsLow(0.89)).toBe(true)
    expect(warnsLow(0.5)).toBe(true)
    expect(warnsLow(0.9)).toBe(false)
  })

  it('reads the pairs in the order given, and drops rows it cannot use', () => {
    const reply = readPairs({
      duplicates: [
        { image_a: { id: 1, filename: 'a.png', path: 'x' }, image_b: { id: 2, filename: 'b.png' }, similarity: 0.99 },
        { image_a: { id: 3, filename: 'c.png' }, image_b: { id: 'x' }, similarity: 0.9 },
        { image_a: { id: 1, filename: 'a.png' }, image_b: { id: 4, filename: 'd.png' }, similarity: 0.7 },
      ],
      total: 3,
      has_more: true,
    })
    expect(reply.pairs.map((p) => [p.a.id, p.b.id, p.similarity])).toEqual([
      [1, 2, 0.99],
      [1, 4, 0.7],
    ])
    expect(reply).toMatchObject({ total: 3, hasMore: true, problem: null })
  })

  it('says why nothing can be compared', () => {
    expect(readPairs({ duplicates: [], reason: 'insufficient_embeddings', embedded_count: 0, minimum_required: 2 }).problem).toEqual({ kind: 'too-few', embedded: 0, minimum: 2 })
    expect(readPairs({ duplicates: [], reason: 'too_many_embeddings', embedded_count: 30000, max_embeddings: 20000 }).problem).toEqual({ kind: 'too-many', embedded: 30000, max: 20000 })
    expect(readPairs(null)).toEqual({ pairs: [], total: 0, hasMore: false, problem: null })
  })

  it('leaves out pairs with an image that is gone', () => {
    const { pairs } = readPairs({
      duplicates: [
        { image_a: { id: 1, filename: 'a' }, image_b: { id: 2, filename: 'b' }, similarity: 0.99 },
        { image_a: { id: 3, filename: 'c' }, image_b: { id: 4, filename: 'd' }, similarity: 0.9 },
      ],
    })
    expect(withoutGone(pairs, new Set([1, 2, 3])).map((p) => p.a.id)).toEqual([1])
  })
})
