import { create } from 'zustand'
import { rawJson } from '../../api/raw'
import type { ImageQueryParams } from '../../lib/searchQuery'
import { apiSort } from '../../lib/sort'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'
import { selectAllMatches } from '../selection/selectAll'
import { parsePins, withPin, type StoredPin } from './pinnedStore'

// "Show exactly these pictures in the library" (the Style Map's picks). The
// ids are stored on the server as a hidden picture set (POST
// /api/collections/pinned, a collection the collection routes never list),
// and the library asks /api/images for that set with the ordinary
// `collection_id` filter: counts, paging, "select all matches" and every
// bulk action see exactly those pictures. They arrive picked, through the
// library's own "select all matches". A banner over the grid says so and
// gives the way back. Changing the search or the rail scope also goes back
// to filtering (as a similarity search does).
//
// Each library remembers its shown set in this browser (like its last
// search), so a reload or coming back to the library shows it again, with
// the banner, as long as the server still has the set; a set the server
// dropped is forgotten without a word. Not a setting: "Reset all settings"
// leaves it, like the library's remembered search.

const STORAGE_KEY = 'sd-v4-library-pins'

export interface PinnedSet extends StoredPin {
  libraryId: string
}

export const usePinned = create<{ pin: PinnedSet | null }>(() => ({ pin: null }))

function readPins(): Record<string, StoredPin> {
  try {
    return parsePins(localStorage.getItem(STORAGE_KEY))
  } catch {
    return {}
  }
}

function remember(libraryId: string, pin: StoredPin | null): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(withPin(readPins(), libraryId, pin)))
  } catch {
    // storage blocked: the set is shown for this visit only
  }
}

/** The library's parameters while a set is shown: only its pictures, in the order the user chose. */
export function pinnedParams(params: ImageQueryParams, pin: PinnedSet | null): ImageQueryParams {
  if (!pin) return params
  return { sort_by: params.sort_by ?? 'newest', collection_id: pin.id }
}

/** Back to the library's own search (the banner's "Show everything", Esc, a new search). */
export function clearPin(): void {
  const pin = usePinned.getState().pin
  if (!pin) return
  usePinned.setState({ pin: null })
  remember(pin.libraryId, null)
}

function show(pin: PinnedSet): void {
  usePinned.setState({ pin })
  remember(pin.libraryId, { id: pin.id, count: pin.count })
}

/**
 * Store these pictures as a set and open the library on it, all of them
 * picked. Resolves the number shown (0 when none of them is in the library
 * any more: nothing opens).
 */
export async function showPinned(ids: readonly number[]): Promise<number> {
  if (ids.length === 0) return 0
  const libraryId = useApp.getState().libraryId
  const made = await rawJson<{ collection_id: number; count: number }>('POST', '/api/collections/pinned', { body: { image_ids: ids }, libraryId })
  if (!made?.count || useApp.getState().libraryId !== libraryId) return 0
  show({ id: made.collection_id, count: made.count, libraryId })
  const s = useApp.getState()
  s.setPage('library')
  try {
    // The same parameters the library page builds for the set, so its selection bar knows every match is picked.
    await selectAllMatches(pinnedParams({ sort_by: apiSort(s.sort, s.sortReverse) }, usePinned.getState().pin), { replace: true })
  } catch (error) {
    useToasts.getState().push(tr('sel.selectAllFailed', { reason: (error as Error).message }), 'error')
  }
  return made.count
}

let restoring = 0

/** The set this library showed last time, if the server still has it (a dropped one is forgotten silently). */
async function restore(libraryId: string): Promise<void> {
  const stored = readPins()[libraryId]
  const mine = ++restoring
  if (!stored) return
  try {
    const found = await rawJson<{ exists?: boolean; count?: number }>('GET', `/api/collections/pinned/${stored.id}`, { libraryId })
    if (mine !== restoring || useApp.getState().libraryId !== libraryId || usePinned.getState().pin) return
    if (found?.exists && (found.count ?? 0) > 0) show({ id: stored.id, count: found.count ?? stored.count, libraryId })
    else remember(libraryId, null)
  } catch {
    // the server cannot say now: keep the memory, show everything
  }
}

useApp.subscribe((s, prev) => {
  if (s.libraryId !== prev.libraryId) {
    // Another library: its own remembered set (if any), never this one's.
    usePinned.setState({ pin: null })
    void restore(s.libraryId)
    return
  }
  // A new search or another rail scope: back to filtering.
  if (s.queryText !== prev.queryText || s.scope !== prev.scope) {
    restoring += 1
    clearPin()
  }
})

void restore(useApp.getState().libraryId)
