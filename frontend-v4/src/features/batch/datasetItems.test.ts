import { describe, expect, test } from 'vitest'
import type { DatasetProjectItem } from '../../api/types'
import {
  inOrder,
  pathKey,
  projectPutItems,
  refKey,
  restoreRefs,
  savedRef,
  UnsurfacedFolderImage,
  withAdded,
  withoutKeys,
  type EntryRef,
} from './datasetItems'

const lib = (source: number, missing = false): DatasetProjectItem => ({
  position: 0,
  item_type: 'library',
  source_image_id: source,
  image_id: missing ? null : source,
  missing,
})

const local = (path: string, status: 'available' | 'missing' | 'changed' = 'available'): DatasetProjectItem => ({
  position: 0,
  item_type: 'local',
  ds_id: 'ds:0123456789abcdef',
  path,
  size: 10,
  mtime_ns: '1',
  device: '2',
  inode: '3',
  source_status: status,
  sidecar_caption: null,
  sidecar_caption_format: null,
  caption_dialect: null,
})

const L = (imageId: number): EntryRef => ({ kind: 'library', imageId })
const F = (path: string): EntryRef => ({ kind: 'folder', path })

describe('the project PUT body', () => {
  test('entries the project already has go back keep_as_saved, missing ones included', () => {
    const saved = [lib(3), lib(9, true), local('C:\\set\\a.png', 'changed')]

    const items = projectPutItems(saved, saved.map(savedRef).reverse(), new Set())

    expect(items).toEqual([
      { item_type: 'local', path: 'C:\\set\\a.png', keep_as_saved: true },
      { item_type: 'library', image_id: 9, keep_as_saved: true },
      { item_type: 'library', image_id: 3, keep_as_saved: true },
    ])
  })

  test('a new Library image goes by id; a new folder image only after a scan or upload surfaced it', () => {
    const saved = [lib(3)]
    const surfaced = new Set([pathKey('D:\\drop\\b.png')])

    const items = projectPutItems(saved, [L(3), L(4), F('D:/drop/b.png')], surfaced)

    expect(items).toEqual([
      { item_type: 'library', image_id: 3, keep_as_saved: true },
      { item_type: 'library', image_id: 4, keep_as_saved: false },
      { item_type: 'local', path: 'D:/drop/b.png', keep_as_saved: false },
    ])
    expect(() => projectPutItems(saved, [L(3), F('D:/elsewhere/c.png')], surfaced)).toThrow(UnsurfacedFolderImage)
  })

  test('a repeated entry is sent once, in its first place, however the path is spelled', () => {
    const saved = [local('C:\\set\\a.png')]
    const surfaced = new Set([pathKey('C:/new/x.png')])

    const items = projectPutItems(saved, [L(5), F('C:/set/a.png'), L(5), F('C:\\set\\a.png'), F('C:/new/x.png'), F('C:\\new\\x.png')], surfaced)

    expect(items).toEqual([
      { item_type: 'library', image_id: 5, keep_as_saved: false },
      { item_type: 'local', path: 'C:\\set\\a.png', keep_as_saved: true },
      { item_type: 'local', path: 'C:/new/x.png', keep_as_saved: false },
    ])
  })

  test('the saved list is left as it was', () => {
    const saved = [lib(1), local('C:/a.png')]
    const before = JSON.stringify(saved)
    projectPutItems(saved, [L(2)], new Set())
    expect(JSON.stringify(saved)).toBe(before)
  })
})

describe('changing the entries', () => {
  const start = [L(1), F('C:/a.png'), L(2)]

  test('adding appends new entries and counts the ones already there', () => {
    const { refs, added, skipped } = withAdded(start, [L(2), F('C:\\a.png'), L(7), L(7)])
    expect(refs.map(refKey)).toEqual(['lib:1', 'dir:C:/a.png', 'lib:2', 'lib:7'])
    expect({ added, skipped }).toEqual({ added: 1, skipped: 3 })
    expect(start).toHaveLength(3)
  })

  test('removing drops the named keys only', () => {
    expect(withoutKeys(start, new Set(['dir:C:/a.png'])).map(refKey)).toEqual(['lib:1', 'lib:2'])
  })

  test('a new order keeps entries it does not name at the end', () => {
    const later = [...start, L(9)]
    expect(inOrder(later, ['lib:2', 'lib:1', 'dir:C:/a.png', 'lib:404']).map(refKey)).toEqual(['lib:2', 'lib:1', 'dir:C:/a.png', 'lib:9'])
  })

  test('undo puts removed entries back in their old places, and keeps what came meanwhile', () => {
    const present = [L(1), L(8)]
    const removed = [F('C:/a.png'), L(2)]
    expect(restoreRefs(start, present, removed).map(refKey)).toEqual(['lib:1', 'dir:C:/a.png', 'lib:2', 'lib:8'])
  })
})
