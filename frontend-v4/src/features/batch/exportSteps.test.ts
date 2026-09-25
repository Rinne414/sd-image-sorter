import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BatchItem } from '../../api/types'
import {
  batchExportSettings,
  DEFAULT_EXPORT,
  DEFAULT_TEMPLATE,
  exportBody,
  newBatchDefaults,
  parseExportSettings,
  readLastUsed,
  rememberLastUsed,
  watermarkProblem,
  withExportSettings,
  type ExportSettings,
} from './exportSettings'
import { cleanOverride, duplicateIds, insertToken, nameBlock, type NamePreview } from './names'
import { applyOrder, dropIndex, moveTo, reorderTarget } from './orderLogic'
import { firstToFix, preflight, readiness, withServerMissing } from './preflight'

function item(id: number, hasCensored: boolean, reviewed?: boolean | null): BatchItem {
  const censor = reviewed === undefined ? undefined : { v: 1, width: 10, height: 10, ops: [], ...(reviewed === null ? {} : { reviewed }) }
  return {
    image_id: id,
    position: id,
    filename: `f${id}.png`,
    width: 10,
    height: 10,
    output_name: null,
    has_censored: hasCensored,
    censored_at: null,
    item_state: censor ? { censor } : null,
  }
}

describe('order', () => {
  it('moves one entry and leaves the input alone', () => {
    const ids = [1, 2, 3, 4]
    expect(moveTo(ids, 0, 2)).toEqual([2, 3, 1, 4])
    expect(moveTo(ids, 3, 0)).toEqual([4, 1, 2, 3])
    expect(ids).toEqual([1, 2, 3, 4])
  })

  it('returns the same list when nothing moves and clamps the target', () => {
    const ids = [1, 2, 3]
    expect(moveTo(ids, 1, 1)).toBe(ids)
    expect(moveTo(ids, 5, 0)).toBe(ids)
    expect(moveTo(ids, 0, 99)).toEqual([2, 3, 1])
  })

  it('maps Alt + arrows, Home and End to a place', () => {
    expect(reorderTarget('ArrowUp', 2, 5)).toBe(1)
    expect(reorderTarget('ArrowLeft', 0, 5)).toBe(0)
    expect(reorderTarget('ArrowDown', 2, 5)).toBe(3)
    expect(reorderTarget('ArrowRight', 4, 5)).toBe(4)
    expect(reorderTarget('Home', 3, 5)).toBe(0)
    expect(reorderTarget('End', 1, 5)).toBe(4)
    expect(reorderTarget('Enter', 1, 5)).toBeNull()
    expect(reorderTarget('Home', -1, 5)).toBeNull()
  })

  it('puts items in a new order, renumbered, extra items last', () => {
    const items = [item(1, false), item(2, false), item(3, false), item(4, false)].map((it, i) => ({ ...it, position: i }))
    const next = applyOrder(items, [3, 1, 2])
    expect(next.map((i) => i.image_id)).toEqual([3, 1, 2, 4])
    expect(next.map((i) => i.position)).toEqual([0, 1, 2, 3])
    expect(items.map((i) => i.image_id)).toEqual([1, 2, 3, 4])
    expect(next[3]).toBe(items[3])
  })

  it('drops before or after the image under the pointer', () => {
    // [a b c d]: a dropped on c's left half lands between b and c.
    expect(dropIndex(0, 2, false)).toBe(1)
    expect(dropIndex(0, 2, true)).toBe(2)
    // d dropped on a's left half becomes first.
    expect(dropIndex(3, 0, false)).toBe(0)
    expect(dropIndex(3, 0, true)).toBe(1)
    // Dropped on itself: stays.
    expect(dropIndex(1, 1, false)).toBe(1)
    expect(dropIndex(1, 1, true)).toBe(1)
  })
})

describe('pre-flight', () => {
  it('classifies censored, unreviewed and missing images', () => {
    expect(readiness(item(1, true))).toBe('censored')
    expect(readiness(item(2, true, true))).toBe('censored')
    expect(readiness(item(3, true, false))).toBe('unreviewed')
    // Approving always saves a copy; an approved image without one is missing.
    expect(readiness(item(4, false, true))).toBe('missing')
    expect(readiness(item(5, false, false))).toBe('missing')
    expect(readiness(item(6, false))).toBe('missing')
    expect(readiness(item(7, false, null))).toBe('missing')
  })

  it('counts and lists what the export needs to know', () => {
    const items = [item(1, true), item(2, true, true), item(3, true, false), item(4, false, true), item(5, false, false), item(6, false)]
    const check = preflight(items)
    expect(check.total).toBe(6)
    expect(check.censored).toBe(3)
    expect(check.reviewed).toBe(2)
    expect(check.missing.map((i) => i.image_id)).toEqual([4, 5, 6])
    expect(check.unreviewed.map((i) => i.image_id)).toEqual([3])
  })

  it('opens the editor at the first missing image, in review when it was detected', () => {
    expect(firstToFix(preflight([item(1, true), item(2, false, false), item(3, false)]))).toEqual({ imageId: 2, review: true })
    expect(firstToFix(preflight([item(1, false), item(2, true, false)]))).toEqual({ imageId: 1, review: false })
    expect(firstToFix(preflight([item(1, true), item(2, true, false)]))).toEqual({ imageId: 2, review: true })
    expect(firstToFix(preflight([item(1, true), item(2, true, true)]))).toBeNull()
  })

  it('adds images the server reported missing, in batch order', () => {
    const items = [item(1, true), item(2, false), item(3, true, false)]
    const check = withServerMissing(preflight(items), items, [3, 1, 99])
    expect(check.missing.map((i) => i.image_id)).toEqual([1, 2, 3])
    expect(check.unreviewed).toEqual([])
    const same = preflight(items)
    expect(withServerMissing(same, items, [2])).toBe(same)
  })
})

describe('names', () => {
  const preview = (over: Partial<NamePreview> = {}): NamePreview => ({ items: [], duplicates: [], template_error: null, ...over })

  it('marks every image in a duplicate group', () => {
    expect([...duplicateIds(preview({ duplicates: [{ output_name: 'a.png', image_ids: [3, 9] }] }))]).toEqual([3, 9])
    expect(duplicateIds(undefined).size).toBe(0)
  })

  it('blocks next on a broken template, duplicates or a preview on its way', () => {
    expect(nameBlock(undefined, false)).toBe('pending')
    expect(nameBlock(preview(), true)).toBe('pending')
    expect(nameBlock(preview({ template_error: { token: '{x}', message: '' } }), false)).toBe('template')
    expect(nameBlock(preview({ duplicates: [{ output_name: 'a', image_ids: [1, 2] }] }), false)).toBe('duplicates')
    expect(nameBlock(preview(), false)).toBeNull()
  })

  it('inserts a token at the caret or over the selection', () => {
    expect(insertToken('set_', '{n:02}', 4, 4)).toEqual({ value: 'set_{n:02}', caret: 10 })
    expect(insertToken('a-XX-b', '{n}', 2, 4)).toEqual({ value: 'a-{n}-b', caret: 5 })
    expect(insertToken('ab', '{batch}', 9, 9)).toEqual({ value: 'ab{batch}', caret: 9 })
  })

  it('treats an empty typed name as "use the template"', () => {
    expect(cleanOverride('  cover ')).toBe('cover')
    expect(cleanOverride('   ')).toBeNull()
  })
})

describe('export settings', () => {
  // Node has no working localStorage: a small in-memory one per test.
  beforeEach(() => {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    })
  })

  const custom: ExportSettings = {
    ...DEFAULT_EXPORT,
    name_template: 'p{n:03}',
    start_number: 5,
    output_folder: 'D:\\posts',
    metadata_option: 'keep',
    output_format: 'jpg',
    overwrite: true,
    caption_text: 'hello',
    watermark: { ...DEFAULT_EXPORT.watermark, enabled: true, text: '@me', color: '#112233' },
  }

  it('starts with the template {batch}_{n:02} and generation data removed', () => {
    expect(DEFAULT_EXPORT.name_template).toBe(DEFAULT_TEMPLATE)
    expect(DEFAULT_TEMPLATE).toBe('{batch}_{n:02}')
    expect(DEFAULT_EXPORT.metadata_option).toBe('strip')
  })

  it("reads a batch's own settings and repairs broken fields", () => {
    const raw = { export: { ...custom, opacity: 'x', output_format: 'gif', start_number: -1, watermark: { ...custom.watermark, opacity: 500, color: 'red' } } }
    const read = batchExportSettings(raw, DEFAULT_EXPORT)
    expect(read.name_template).toBe('p{n:03}')
    expect(read.metadata_option).toBe('keep')
    expect(read.output_format).toBe('original')
    expect(read.start_number).toBe(1)
    expect(read.watermark.opacity).toBe(80)
    expect(read.watermark.color).toBe('#FFFFFF')
    expect(read.watermark.text).toBe('@me')
  })

  it('gives a new batch the last settings but never keep, overwrite or the old caption', () => {
    const fresh = batchExportSettings({}, custom)
    expect(fresh.output_folder).toBe('D:\\posts')
    expect(fresh.name_template).toBe('p{n:03}')
    expect(fresh.watermark.text).toBe('@me')
    expect(fresh.metadata_option).toBe('strip')
    expect(fresh.overwrite).toBe(false)
    expect(fresh.caption_text).toBe('')
    expect(newBatchDefaults(custom)).not.toBe(custom)
  })

  it('remembers the last settings in localStorage and survives junk', () => {
    expect(readLastUsed()).toEqual(DEFAULT_EXPORT)
    rememberLastUsed(custom)
    expect(readLastUsed()).toEqual(custom)
    localStorage.setItem('sd-v4-pixiv-export', '{not json')
    expect(readLastUsed()).toEqual(DEFAULT_EXPORT)
  })

  it('puts the settings into the batch settings without touching the rest', () => {
    const before = { source_collection_id: 4 }
    const after = withExportSettings(before, custom)
    expect(after).toEqual({ source_collection_id: 4, export: custom })
    expect(before).toEqual({ source_collection_id: 4 })
    expect(parseExportSettings(after.export)).toEqual(custom)
  })

  it('builds the export request with the chosen policy', () => {
    const body = exportBody(custom, 'skip')
    expect(body).toMatchObject({ output_folder: 'D:\\posts', missing_censored: 'skip', metadata_option: 'keep', name_template: 'p{n:03}' })
    expect(body.watermark.text).toBe('@me')
  })

  it('refuses a watermark without text', () => {
    expect(watermarkProblem({ ...DEFAULT_EXPORT.watermark, enabled: true, text: ' ' })).toBe('text')
    expect(watermarkProblem({ ...DEFAULT_EXPORT.watermark, enabled: false })).toBeNull()
  })
})
