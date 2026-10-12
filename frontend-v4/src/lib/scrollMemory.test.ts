import { describe, expect, test } from 'vitest'
import { firstVisibleIndex, parseScrollStore, rememberSpot, resumeIndex, spotToResume, RESUME_MAX_AGE_MS, type ScrollSpot } from './scrollMemory'

const NOW = 1_800_000_000_000
const spot = (over: Partial<ScrollSpot> = {}): ScrollSpot => ({ key: 'q1', index: 300, id: 42, at: NOW - 1000, ...over })

describe('where to come back to', () => {
  test('the same search in the same library comes back to its spot', () => {
    const store = rememberSpot({}, 'main', spot())
    expect(spotToResume(store, 'main', 'q1', NOW)).toEqual(spot())
  })

  test('another search, another library, the top of the list or an old spot: start at the top', () => {
    const store = rememberSpot(rememberSpot({}, 'main', spot()), 'lib-2', spot({ key: 'q2', index: 0 }))
    expect(spotToResume(store, 'main', 'q-other', NOW)).toBeNull()
    expect(spotToResume(store, 'lib-3', 'q1', NOW)).toBeNull()
    expect(spotToResume(store, 'lib-2', 'q2', NOW)).toBeNull()
    expect(spotToResume(rememberSpot({}, 'main', spot({ at: NOW - RESUME_MAX_AGE_MS - 1 })), 'main', 'q1', NOW)).toBeNull()
  })

  test('each library keeps its own spot, and a new one replaces the old', () => {
    let store = rememberSpot({}, 'main', spot())
    store = rememberSpot(store, 'lib-2', spot({ key: 'q9', index: 12, id: 7 }))
    store = rememberSpot(store, 'main', spot({ index: 8, id: 3 }))
    expect(store).toEqual({ main: spot({ index: 8, id: 3 }), 'lib-2': spot({ key: 'q9', index: 12, id: 7 }) })
  })

  test('survives a reload; damaged storage reads as nothing', () => {
    const store = rememberSpot({}, 'main', spot())
    expect(parseScrollStore(JSON.stringify(store))).toEqual(store)
    expect(parseScrollStore('nope')).toEqual({})
    expect(parseScrollStore(JSON.stringify({ main: { key: 'q', index: 'x', id: 1, at: 1 }, b: spot() }))).toEqual({ b: spot() })
  })
})

describe('resumeIndex', () => {
  const ids = Array.from({ length: 400 }, (_, i) => i + 1)

  test('the remembered image, wherever it is now', () => {
    expect(resumeIndex(spot({ id: 42, index: 300 }), ids)).toBe(41)
  })

  test('the image is gone: the same position, once that many are loaded', () => {
    expect(resumeIndex(spot({ id: 9999, index: 300 }), ids)).toBe(300)
    expect(resumeIndex(spot({ id: 9999, index: 300 }), ids.slice(0, 240))).toBeNull()
  })

  test('the image is not loaded yet: wait for more pages', () => {
    expect(resumeIndex(spot({ id: 380, index: 379 }), ids.slice(0, 240))).toBeNull()
  })
})

describe('firstVisibleIndex', () => {
  // two lanes of different heights, as the masonry lays them out
  const items = [
    { index: 0, start: 0, end: 300 },
    { index: 1, start: 0, end: 150 },
    { index: 2, start: 156, end: 400 },
    { index: 3, start: 306, end: 500 },
    { index: 4, start: 406, end: 700 },
  ]

  test('the first image in list order that still shows at the top edge', () => {
    expect(firstVisibleIndex(items, 0)).toBe(0)
    expect(firstVisibleIndex(items, 320)).toBe(2)
    expect(firstVisibleIndex(items, 450)).toBe(3)
    expect(firstVisibleIndex(items, 5000)).toBe(4)
    expect(firstVisibleIndex([], 100)).toBe(0)
  })
})
