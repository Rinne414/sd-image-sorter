import { describe, expect, it } from 'vitest'
import { intersectPages, type MatchPages } from './batchMatch'

/** A fake token + chunk source over `ids`, recording the offsets asked for. */
function pages(ids: number[], size: number): MatchPages & { asked: number[]; tokens: number } {
  const source = {
    asked: [] as number[],
    tokens: 0,
    token: async () => {
      source.tokens += 1
      return 'tok'
    },
    chunk: async (_token: string, offset: number) => {
      source.asked.push(offset)
      const image_ids = ids.slice(offset, offset + size)
      const has_more = offset + size < ids.length
      return { image_ids, has_more, next_offset: has_more ? offset + size : null }
    },
  }
  return source
}

describe('a library condition matched against a batch', () => {
  it('keeps only the batch images among the library matches, page by page', async () => {
    const source = pages([1, 2, 3, 4, 5, 6, 7, 8], 3)
    expect([...(await intersectPages(source, [7, 2, 99]))].sort()).toEqual([2, 7])
    expect(source.asked).toEqual([0, 3, 6])
  })

  it('stops paging once every batch image is found', async () => {
    const source = pages([1, 2, 3, 4, 5, 6, 7, 8], 3)
    expect([...(await intersectPages(source, [1, 4]))].sort()).toEqual([1, 4])
    expect(source.asked).toEqual([0, 3])
  })

  it('asks nothing for a batch with no library images', async () => {
    const source = pages([1, 2], 3)
    expect((await intersectPages(source, [])).size).toBe(0)
    expect(source.tokens).toBe(0)
  })

  it('stops when the server does not move forward', async () => {
    const stuck: MatchPages = {
      token: async () => 'tok',
      chunk: async () => ({ image_ids: [5], has_more: true, next_offset: 0 }),
    }
    expect([...(await intersectPages(stuck, [5, 6]))]).toEqual([5])
  })
})
