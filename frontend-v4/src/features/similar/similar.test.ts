import { describe, expect, it } from 'vitest'
import type { ImageDetailResponse, ImageSummary } from '../../api/types'
import { compareDetails, diffTags } from './compare'
import { canMark, marksOf, reclaimable, toggleMark, withExisting, type DupGroup } from './duplicates'
import { mergeRanked, percent, readHits } from './ranking'

const row = (id: number): ImageSummary => ({
  id,
  filename: `${id}.png`,
  path: `D:\\a\\${id}.png`,
  generator: 'nai',
  width: 64,
  height: 96,
  file_size: 100,
  checkpoint: null,
  checkpoint_normalized: null,
  loras: null,
  user_rating: 0,
  aesthetic_score: null,
  is_readable: 1,
  metadata_status: 'complete',
  created_at: null,
  library_order_time: null,
})

describe('ranked results', () => {
  it('keeps the ranking, attaches the score and drops ids without a row', () => {
    const hits = [
      { id: 3, similarity: 0.97 },
      { id: 1, similarity: 0.8 },
      { id: 9, similarity: 0.7 },
      { id: 3, similarity: 0.5 },
    ]
    const out = mergeRanked(hits, [row(1), row(3)])
    expect(out.map((r) => [r.id, r.similarity])).toEqual([
      [3, 0.97],
      [1, 0.8],
    ])
  })

  it('keeps only scores at or above the floor (near-duplicates: 0.9)', () => {
    const out = mergeRanked(
      [
        { id: 1, similarity: 0.95 },
        { id: 2, similarity: 0.9 },
        { id: 3, similarity: 0.89 },
      ],
      [row(1), row(2), row(3)],
      0.9,
    )
    expect(out.map((r) => r.id)).toEqual([1, 2])
  })

  it('reads hits from any endpoint and shows scores as percent', () => {
    expect(readHits([{ id: 4, similarity: 0.5, filename: 'x' }, { id: 'x' }, null])).toEqual([{ id: 4, similarity: 0.5 }])
    expect(readHits(undefined)).toEqual([])
    expect(percent(0.9734)).toBe('97%')
    expect(percent(0.9994)).toBe('99%')
    expect(percent(1)).toBe('100%')
    expect(percent(0.2)).toBe('20%')
  })
})

function detail(id: number, over: Partial<ImageDetailResponse['image']>, tags: string[] = []): ImageDetailResponse {
  return {
    image: {
      ...row(id),
      prompt: null,
      negative_prompt: null,
      metadata_json: JSON.stringify({ _parsed: { generation_params: { seed: 1, steps: 28, cfg_scale: 5, sampler: 'k_euler' } } }),
      ai_caption: null,
      nl_caption: null,
      sidecar_caption: null,
      tagged_at: null,
      ...over,
    },
    tags: [...tags.map((tag) => ({ tag, confidence: 0.9, source: 'tagger', category: 'general' })), { tag: 'general', confidence: 1, source: 'tagger', category: 'rating' }],
  }
}

describe('compare two', () => {
  it('lists each parameter with same or different', () => {
    const a = detail(1, { width: 64, height: 96, prompt: '1girl, smile, frame 0' }, ['smile', 'solo'])
    const b = detail(2, {
      width: 96,
      height: 64,
      prompt: '1girl, (smile:1.2), frame 1',
      metadata_json: JSON.stringify({ _parsed: { generation_params: { seed: 2, steps: 28, cfg_scale: 5, sampler: 'k_euler' } } }),
    }, ['smile', 'outdoors'])
    const c = compareDetails(a, b)
    const byKey = Object.fromEntries(c.rows.map((r) => [r.key, r]))
    expect(byKey.size).toMatchObject({ a: '64×96', b: '96×64', same: false })
    expect(byKey.seed).toMatchObject({ a: '1', b: '2', same: false })
    expect(byKey.steps).toMatchObject({ same: true })
    // parameters neither image has are not listed
    expect(byKey.denoise).toBeUndefined()
    // weights and brackets do not make a tag different
    expect(c.promptTags).toEqual({ onlyA: ['frame 0'], onlyB: ['frame 1'], shared: 2 })
    // the rating is not a tag here
    expect(c.tags).toEqual({ onlyA: ['solo'], onlyB: ['outdoors'], shared: 1 })
  })

  it('treats underscores and case alike', () => {
    expect(diffTags(['Silver_Hair', 'x'], ['silver hair'])).toEqual({ onlyA: ['x'], onlyB: [], shared: 1 })
  })
})

const member = (id: number, keep = false, size = 10) => ({
  id,
  path: '',
  filename: `${id}.png`,
  width: 1,
  height: 1,
  file_size: size,
  aesthetic_score: null,
  user_rating: null,
  suggested_keep: keep,
})

describe('duplicate groups', () => {
  const group: DupGroup = { group_id: 0, similarity: 0.97, members: [member(5, true), member(6), member(7)] }

  it('marks every image but the suggested keeper for the trash until the user ticks otherwise', () => {
    expect(marksOf(group, undefined)).toEqual([6, 7])
    expect(marksOf(group, new Set([7]))).toEqual([7])
    // two kept: only the rest go
    expect(marksOf(group, new Set([6]))).toEqual([6])
    expect(marksOf(group, new Set())).toEqual([])
  })

  it('never leaves a group with nothing kept', () => {
    // ticking the last kept image is refused
    const ticks = new Set([6, 7])
    expect(canMark(group, ticks, 5)).toBe(false)
    expect(toggleMark(group, ticks, 5)).toEqual(ticks)
    // any other tick or untick goes through
    expect(canMark(group, ticks, 6)).toBe(true)
    expect(toggleMark(group, ticks, 6)).toEqual(new Set([7]))
    expect(toggleMark(group, new Set([7]), 5)).toEqual(new Set([7, 5]))
    // ticks saved before members went away still keep one (the suggested keeper)
    const shrunk: DupGroup = { ...group, members: [member(5, true), member(7)] }
    expect(marksOf(shrunk, new Set([5, 7]))).toEqual([7])
    for (const t of [undefined, new Set<number>(), new Set([5, 6]), new Set([5, 6, 7])]) {
      expect(marksOf(group, t).length).toBeLessThan(group.members.length)
    }
  })

  it('only marks members of the group', () => {
    expect(marksOf(group, new Set([6, 99]))).toEqual([6])
    expect(canMark(group, new Set(), 99)).toBe(false)
  })

  it('drops members that are gone and groups left with one image', () => {
    const second: DupGroup = { group_id: 1, similarity: 0.99, members: [member(8, true), member(9)] }
    const out = withExisting([group, second], new Set([5, 7, 8]))
    expect(out).toHaveLength(1)
    expect(out[0]!.members.map((m) => m.id)).toEqual([5, 7])
  })

  it('counts the bytes of what is marked', () => {
    const g2: DupGroup = { group_id: 1, similarity: 0.99, members: [member(8, true, 100), member(9, false, 40)] }
    expect(reclaimable([group, g2], new Map())).toBe(20 + 40)
    expect(reclaimable([group, g2], new Map([[1, new Set([8])]]))).toBe(20 + 100)
    expect(reclaimable([group, g2], new Map([[0, new Set<number>()]]))).toBe(40)
  })
})
