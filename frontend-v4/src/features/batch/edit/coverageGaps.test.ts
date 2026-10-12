import { afterEach, describe, expect, test, vi } from 'vitest'

// The app's stores read the address and storage when they load: a bare page for them (tests run in node).
vi.hoisted(() => {
  const store = new Map<string, string>()
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  }
  const location = { pathname: '/v4/', search: '', hash: '' }
  const window = Object.assign(new EventTarget(), { location })
  Object.assign(globalThis, { window, location, localStorage: fake, sessionStorage: fake })
})

import { api } from '../../../api/client'
import { coverageGaps } from './bulkApi'

// POST /api/tags/coverage-gaps answers one page (at most 2,000 gaps) with
// has_more; "find missed" must list every gap, not the first page.

const answer = (data: unknown) => ({ data, response: new Response(null, { status: 200 }) }) as never

afterEach(() => vi.restoreAllMocks())

describe('coverageGaps', () => {
  test('reads page after page until the backend says there is no more', async () => {
    const gap = (id: number) => ({ image_id: id, filename: `${id}.png`, score: 0.3 })
    const post = vi
      .spyOn(api, 'POST')
      .mockResolvedValueOnce(answer({ gaps: [gap(1), gap(2)], has_more: true }))
      .mockResolvedValueOnce(answer({ gaps: [gap(3)], has_more: false }))

    const gaps = await coverageGaps('long hair', [1, 2, 3])

    expect(gaps.map((g) => g.image_id)).toEqual([1, 2, 3])
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[0]![1]).toMatchObject({ body: { tag: 'long_hair', image_ids: [1, 2, 3], limit: 2000, offset: 0 } })
    expect(post.mock.calls[1]![1]).toMatchObject({ body: { offset: 2 } })
  })

  test('an answer without has_more is the only page', async () => {
    const post = vi.spyOn(api, 'POST').mockResolvedValueOnce(answer({ gaps: [] }))
    expect(await coverageGaps('smile', [])).toEqual([])
    expect(post).toHaveBeenCalledTimes(1)
  })
})
