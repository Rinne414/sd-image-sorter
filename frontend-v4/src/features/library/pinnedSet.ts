import { create } from 'zustand'
import { rawJson } from '../../api/raw'
import type { ImageQueryParams } from '../../lib/searchQuery'
import { useApp } from '../../state/store'

// "Show exactly these pictures in the library" (the Style Map's picks). The
// ids are stored on the server as a hidden picture set (POST
// /api/collections/pinned, a collection the collection routes never list),
// and the library asks /api/images for that set with the ordinary
// `collection_id` filter: counts, paging, "select all matches" and every
// bulk action see exactly those pictures. A banner over the grid says so and
// gives the way back. Changing the search or the rail scope, or switching
// libraries, goes back to filtering (as a similarity search does).

export interface PinnedSet {
  /** The hidden set's collection id. */
  id: number
  count: number
  libraryId: string
}

export const usePinned = create<{ pin: PinnedSet | null }>(() => ({ pin: null }))

/** The library's parameters while a set is shown: only its pictures, in the order the user chose. */
export function pinnedParams(params: ImageQueryParams, pin: PinnedSet | null): ImageQueryParams {
  if (!pin) return params
  return { sort_by: params.sort_by ?? 'newest', collection_id: pin.id }
}

export function clearPin(): void {
  if (usePinned.getState().pin) usePinned.setState({ pin: null })
}

/**
 * Store these pictures as a set and open the library on it. Resolves the
 * number shown (0 when none of them is in the library any more: nothing opens).
 */
export async function showPinned(ids: readonly number[]): Promise<number> {
  if (ids.length === 0) return 0
  const libraryId = useApp.getState().libraryId
  const made = await rawJson<{ collection_id: number; count: number }>('POST', '/api/collections/pinned', { body: { image_ids: ids }, libraryId })
  if (!made?.count) return 0
  usePinned.setState({ pin: { id: made.collection_id, count: made.count, libraryId } })
  useApp.getState().setPage('library')
  return made.count
}

// A new search, another rail scope or another library: back to filtering.
useApp.subscribe((s, prev) => {
  if (s.libraryId !== prev.libraryId || s.queryText !== prev.queryText || s.scope !== prev.scope) clearPin()
})
