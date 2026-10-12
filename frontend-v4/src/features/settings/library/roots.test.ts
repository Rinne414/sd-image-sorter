import { describe, expect, test } from 'vitest'
import { missingRoots, orderRoots, removalSummary, rootName, rootsSummary, scannedAt } from './roots'
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

describe('removing every folder that is gone', () => {
  test('takes exactly the folders that are gone, in the list order', () => {
    const list = [root({ id: 1 }), root({ id: 2, exists: false }), root({ id: 3, exists: null as unknown as boolean }), root({ id: 4, exists: false })]
    expect(missingRoots(list).map((r) => r.id)).toEqual([2, 4])
  })

  test('says how many went and names the ones that could not be removed', () => {
    const a = root({ id: 1, path: 'D:/gone/a' })
    const b = root({ id: 2, path: 'E:/old/b' })
    expect(removalSummary([{ root: a, ok: true }, { root: b, ok: true }])).toEqual({ removed: 2, failed: [] })
    expect(removalSummary([{ root: a, ok: true }, { root: b, ok: false }])).toEqual({ removed: 1, failed: ['b'] })
  })
})
