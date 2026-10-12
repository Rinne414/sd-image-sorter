import { describe, expect, test } from 'vitest'
import { cleanOutcome, diskSize, initialPicks, LIMIT_MAX_MB, parseLimit, pickedBytes, thumbState, unknownPicked } from './disk'
import type { CacheEntry } from './types'

const entry = (key: string, size: number | null, complete = true): CacheEntry => ({
  key,
  label_key: `disk.${key}`,
  path: `D:/data/${key}`,
  size_bytes: size,
  size_complete: complete,
  exists: true,
})

describe('parseLimit', () => {
  test('0 turns the cache off and is a valid limit', () => {
    expect(parseLimit('0')).toBe(0)
    expect(parseLimit(' 0 ')).toBe(0)
  })

  test('whole megabytes up to the backend limit; decimals round', () => {
    expect(parseLimit('500')).toBe(500)
    expect(parseLimit('250.6')).toBe(251)
    expect(parseLimit(String(LIMIT_MAX_MB))).toBe(102400)
  })

  test('empty, negative, too large or not a number is refused', () => {
    expect(parseLimit('')).toBeNull()
    expect(parseLimit('-1')).toBeNull()
    expect(parseLimit('102401')).toBeNull()
    expect(parseLimit('abc')).toBeNull()
    expect(parseLimit('1e9')).toBeNull()
  })
})

describe('diskSize', () => {
  test('bytes, KB, MB and GB', () => {
    expect(diskSize(0)).toBe('0 B')
    expect(diskSize(900)).toBe('900 B')
    expect(diskSize(1536)).toBe('2 KB')
    expect(diskSize(5_000_000)).toBe('4.8 MB')
    expect(diskSize(16_865_652)).toBe('16 MB')
    expect(diskSize(26_791_442_397)).toBe('25.0 GB')
  })

  test('an unknown size stays unknown', () => {
    expect(diskSize(null)).toBeNull()
    expect(diskSize(undefined)).toBeNull()
  })
})

describe('what to clean', () => {
  const safe = [entry('tmp', 123_862), entry('pip_cache', 0), entry('thumbnails', 16_865_652), entry('cache', null, false)]

  test('caches that take space start ticked; empty ones do not', () => {
    expect([...initialPicks(safe)].sort()).toEqual(['thumbnails', 'tmp'])
  })

  test('the ticked total counts known sizes only', () => {
    expect(pickedBytes(safe, new Set(['tmp', 'thumbnails', 'cache']))).toBe(123_862 + 16_865_652)
  })

  test('ticked caches whose size was not fully counted are named before cleaning', () => {
    expect(unknownPicked(safe, new Set(['tmp']))).toEqual([])
    expect(unknownPicked(safe, new Set(['tmp', 'cache'])).map((e) => e.key)).toEqual(['cache'])
  })

  test('the outcome adds up what was freed and keeps the errors', () => {
    const result = { cleaned: [{ key: 'tmp', freed_bytes: 1000 }, { key: 'cache', freed_bytes: 24 }], errors: [{ key: 'thumbnails', error: 'locked' }] }
    expect(cleanOutcome(result)).toEqual({ freed: 1024, errors: [{ key: 'thumbnails', error: 'locked' }] })
    expect(cleanOutcome({})).toEqual({ freed: 0, errors: [] })
  })
})

describe('thumbState', () => {
  test('the saved limit wins over the cache stats; the size may be unknown', () => {
    expect(thumbState({ settings: { thumbnail_cache_max_mb: 0 }, thumbnail_cache: { total_size_bytes: 5, max_size_mb: 500 } })).toEqual({ limitMb: 0, usedBytes: 5 })
    expect(thumbState({ thumbnail_cache: { total_size_bytes: null, max_size_mb: 750 } })).toEqual({ limitMb: 750, usedBytes: null })
    expect(thumbState({})).toEqual({ limitMb: 500, usedBytes: null })
  })
})
