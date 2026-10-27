import { useApp } from '../../../state/store'
import type { QueueItem } from './privacyStore'

/** The library file could not be read back. */
export class LibraryReadError extends Error {}

/** The original's bytes: the file brought in, or the library file fetched again. */
export async function originalOf(item: QueueItem): Promise<Blob> {
  if (item.source.kind === 'file') return item.source.file
  const res = await fetch(`/api/image-file/${item.source.id}`, { headers: { 'X-SD-Library-Id': useApp.getState().libraryId } }).catch((error: Error) => {
    throw new LibraryReadError(error.message)
  })
  if (!res.ok) throw new LibraryReadError(`${res.status} ${res.statusText}`.trim())
  return res.blob()
}
