import { describe, expect, test } from 'vitest'
import { orderRoots, rootName, rootsSummary, scannedAt } from './roots'
import type { LibraryRoot } from './types'

const root = (fields: Partial<LibraryRoot>): LibraryRoot => ({
  id: 1,
  path: 'D:/art/nai',
  image_count: 0,
  exists: true,
  last_scanned_at: null,
  ...fields,
})

describe('roots', () => {
  test('the summary counts folders and the ones that are gone', () => {
    expect(rootsSummary([root({ id: 1 }), root({ id: 2, exists: false }), root({ id: 3, exists: false })])).toEqual({ folders: 3, missing: 2 })
    expect(rootsSummary([])).toEqual({ folders: 0, missing: 0 })
  })

  test('folders that are gone go after the ones still there, each group in the backend order', () => {
    const list = [root({ id: 5, exists: false }), root({ id: 4 }), root({ id: 3, exists: false }), root({ id: 2 })]
    expect(orderRoots(list).map((r) => r.id)).toEqual([4, 2, 5, 3])
  })

  test('the last import reads as a date and a time', () => {
    expect(scannedAt('2026-09-06T21:58:03')).toBe('2026-09-06 21:58')
    expect(scannedAt(null)).toBeNull()
  })

  test('a folder is named by its last part', () => {
    expect(rootName('L:/Antigravitiy code/style_separate/NAI style')).toBe('NAI style')
    expect(rootName('D:/')).toBe('D:/')
    expect(rootName('/srv/pics/')).toBe('pics')
  })
})
