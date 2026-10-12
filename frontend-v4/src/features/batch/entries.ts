import type { BatchItem, BatchProjectView, ImageSummary } from '../../api/types'
import { thumbnailUrl } from '../../api/urls'
import { folderKey, libraryKey, savedRef, type EntryRef } from './datasetItems'

// What the Pick and Order steps show for any batch: its images in order. A
// Pixiv or custom batch's come from its own items; a dataset batch's from
// its project, where folder images (not in the Library) sit beside Library ones.

export interface Entry {
  key: string
  ref: EntryRef
  /** The Library image to show; null for a folder image or a Library image that is gone. */
  imageId: number | null
  /** A folder image's path on disk. */
  path: string | null
  filename: string
  width: number | null
  height: number | null
  status: 'ok' | 'missing' | 'changed'
  /** The batch item of a Pixiv or custom batch (censored copy, export name). */
  item: BatchItem | null
}

export function entriesFromItems(items: readonly BatchItem[]): Entry[] {
  return items.map((item) => ({
    key: libraryKey(item.image_id),
    ref: { kind: 'library', imageId: item.image_id },
    imageId: item.image_id,
    path: null,
    filename: item.filename,
    width: item.width,
    height: item.height,
    status: 'ok',
    item,
  }))
}

function tail(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

export function entriesFromProject(view: BatchProjectView): Entry[] {
  const info = new Map(view.library_images.map((row) => [row.id, row]))
  return view.project.items.map((item) => {
    const ref = savedRef(item)
    if (item.item_type === 'library') {
      const row = info.get(item.source_image_id)
      return {
        key: libraryKey(item.source_image_id),
        ref,
        imageId: item.image_id,
        path: null,
        filename: row?.filename ?? `#${item.source_image_id}`,
        width: row?.width ?? null,
        height: row?.height ?? null,
        status: item.missing ? 'missing' : 'ok',
        item: null,
      }
    }
    return {
      key: folderKey(item.path),
      ref,
      imageId: null,
      path: item.path,
      filename: tail(item.path),
      width: null,
      height: null,
      status: item.source_status === 'available' ? 'ok' : item.source_status,
      item: null,
    }
  })
}

export const localThumbnailUrl = (path: string, size: number) =>
  `/api/dataset/local-thumbnail?path=${encodeURIComponent(path)}&size=${size}`

/** The thumbnail to show, or null when there is no picture left to show. */
export function entryThumb(entry: Entry, size: number): string | null {
  if (entry.imageId !== null) return thumbnailUrl(entry.imageId, size)
  if (entry.path !== null && entry.status !== 'missing') return localThumbnailUrl(entry.path, size)
  return null
}

/** Enough of an image summary for the lightbox (Library images only); the card loads the rest. */
export function entrySummary(entry: Entry & { imageId: number }): ImageSummary {
  return {
    id: entry.imageId,
    filename: entry.filename,
    path: '',
    generator: null,
    width: entry.width,
    height: entry.height,
    file_size: null,
    checkpoint: null,
    checkpoint_normalized: null,
    loras: null,
    user_rating: null,
    aesthetic_score: null,
    is_readable: null,
    metadata_status: null,
    created_at: null,
    library_order_time: null,
  }
}
