import type { ImageSummary } from '../../../api/types'
import { useToasts } from '../../../ui/toasts'
import { imagesByIds } from '../../similar/similarApi'
import { imagesOf } from '../intake/intakeFiles'
import { SIZE_PROBE_BYTES, sniffImageSize } from './engine/imageSize'
import { pt } from './privacyText'
import { appendItems, findItem, nextKey, patchItem, type ItemSource, type QueueItem } from './privacyStore'

// Images into the queue: files dropped, chosen or pasted, and library images
// sent with "送到工具 ▸ 隐私混淆". Nothing is processed until the user presses
// Protect all / Restore all; library originals are fetched only then.

/** The by-ids endpoint's most per request. */
const BY_IDS_CHUNK = 2000

function newItem(source: ItemSource, fileName: string, size: QueueItem['size']): QueueItem {
  return { key: nextKey(), source, fileName, rename: null, size, state: 'waiting', problem: null, result: null }
}

/** Read the size from the file's first bytes, so a huge image is flagged before it is processed. */
async function sniffSize(key: number, file: File): Promise<void> {
  try {
    const size = sniffImageSize(new Uint8Array(await file.slice(0, SIZE_PROBE_BYTES).arrayBuffer()))
    if (size && !findItem(key)?.size) patchItem(key, { size })
  } catch {
    // an unreadable header: the size shows once the image is processed
  }
}

export function addFiles(files: File[]): void {
  const images = imagesOf(files)
  if (!images.length) {
    useToasts.getState().push(pt('privacy.noImages'), 'error')
    return
  }
  const items = images.map((file) => newItem({ kind: 'file', file, url: URL.createObjectURL(file) }, file.name || 'image.png', null))
  appendItems(items)
  useToasts.getState().push(pt('privacy.added', { n: items.length }))
  items.forEach((item, i) => void sniffSize(item.key, images[i]!))
}

const sizeOf = (row: ImageSummary) => (row.width && row.height ? { width: row.width, height: row.height } : null)

/** Library images, in the order sent; says how many came in (and how many are gone) before anything runs. */
export async function addLibraryImages(ids: readonly number[]): Promise<void> {
  const wanted = [...new Set(ids)]
  const rows: ImageSummary[] = []
  try {
    for (let at = 0; at < wanted.length; at += BY_IDS_CHUNK) rows.push(...(await imagesByIds(wanted.slice(at, at + BY_IDS_CHUNK))))
  } catch (error) {
    useToasts.getState().push(pt('privacy.err.library', { detail: (error as Error).message }), 'error')
    return
  }
  appendItems(rows.map((row) => newItem({ kind: 'library', id: row.id }, row.filename || `image-${row.id}.png`, sizeOf(row))))
  if (rows.length) useToasts.getState().push(pt('privacy.addedFromLibrary', { n: rows.length }))
  const gone = wanted.length - rows.length
  if (gone > 0) useToasts.getState().push(pt('privacy.libraryGone', { n: gone }), 'error')
}
