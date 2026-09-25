import { describe, expect, test } from 'vitest'
import type { BatchProjectView } from '../../api/types'
import { entriesFromProject, entryThumb } from './entries'

const view = {
  project: {
    id: 1,
    name: 'Set',
    revision: 3,
    archived_at: null,
    created_at: '',
    updated_at: '',
    missing_image_ids: [9],
    settings: {},
    items: [
      { position: 0, item_type: 'library', source_image_id: 4, image_id: 4, missing: false },
      { position: 1, item_type: 'library', source_image_id: 9, image_id: null, missing: true },
      {
        position: 2,
        item_type: 'local',
        ds_id: 'ds:0123456789abcdef',
        path: 'D:\\sets\\a b.png',
        size: 1,
        mtime_ns: '1',
        device: '1',
        inode: '1',
        source_status: 'changed',
        sidecar_caption: null,
        sidecar_caption_format: null,
        caption_dialect: null,
      },
    ],
  },
  library_images: [{ id: 4, filename: 'four.png', width: 40, height: 30 }],
  uploaded_count: 0,
} as unknown as BatchProjectView

describe('a dataset project as pick-step entries', () => {
  test('Library images get their names, folder images their file name and status', () => {
    const entries = entriesFromProject(view)
    expect(entries.map((e) => [e.key, e.filename, e.status, e.imageId])).toEqual([
      ['lib:4', 'four.png', 'ok', 4],
      ['lib:9', '#9', 'missing', null],
      ['dir:D:/sets/a b.png', 'a b.png', 'changed', null],
    ])
  })

  test('thumbnails: by id, by path for a folder image that is still there, none for a missing one', () => {
    const [four, gone, local] = entriesFromProject(view)
    expect(entryThumb(four!, 256)).toBe('/api/image-thumbnail/4?size=256')
    expect(entryThumb(gone!, 256)).toBeNull()
    expect(entryThumb(local!, 256)).toBe('/api/dataset/local-thumbnail?path=D%3A%5Csets%5Ca%20b.png&size=256')
  })
})
