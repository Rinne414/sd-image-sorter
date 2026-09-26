import { describe, expect, test } from 'vitest'
import { readTagFile, skipReasons } from './tagBackup'

const file = (images: unknown) => JSON.stringify({ version: '1.0', count: 3, images })

describe('readTagFile', () => {
  test('counts the images that carry tags or a description before anything is imported', () => {
    const read = readTagFile(
      file([
        { path: 'D:/a.png', filename: 'a.png', tags: [{ tag: '1girl', confidence: 0.9 }], ai_caption: '' },
        { path: 'D:/b.png', filename: 'b.png', tags: [], ai_caption: 'a girl in rain' },
        { path: 'D:/c.png', filename: 'c.png', tags: [], ai_caption: '  ' },
        { path: 'D:/d.png', filename: 'd.png', tags: [{ tag: '  ' }, 'solo'] },
        'not an image',
      ]),
    )
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.total).toBe(5)
    expect(read.usable).toBe(2)
    expect(read.empty).toBe(3)
    // only the usable entries are sent (a non-object entry would be refused by the backend)
    expect(read.images.map((i) => i.filename)).toEqual(['a.png', 'b.png'])
  })

  test('a file with no usable entry is read, with nothing to import', () => {
    const read = readTagFile(file([]))
    expect(read).toEqual({ ok: true, images: [], total: 0, usable: 0, empty: 0 })
  })

  test('broken JSON and the wrong layout are told apart', () => {
    expect(readTagFile('{not json')).toEqual({ ok: false, reason: 'json' })
    expect(readTagFile('[1, 2]')).toEqual({ ok: false, reason: 'shape' })
    expect(readTagFile('{"images": {}}')).toEqual({ ok: false, reason: 'shape' })
    expect(readTagFile('null')).toEqual({ ok: false, reason: 'shape' })
  })
})

describe('skipReasons', () => {
  const result = { imported: 3, skipped: 0, not_found: 0, ambiguous: 0, already_tagged: 0, duplicate: 0 }

  test('lists only the reasons that skipped something, in a fixed order', () => {
    expect(skipReasons({ ...result, skipped: 6, duplicate: 1, not_found: 2, already_tagged: 3 })).toEqual([
      { reason: 'not_found', n: 2 },
      { reason: 'already_tagged', n: 3 },
      { reason: 'duplicate', n: 1 },
    ])
    expect(skipReasons({ ...result, skipped: 1, ambiguous: 1 })).toEqual([{ reason: 'ambiguous', n: 1 }])
  })

  test('nothing skipped: nothing to explain', () => {
    expect(skipReasons(result)).toEqual([])
  })
})
