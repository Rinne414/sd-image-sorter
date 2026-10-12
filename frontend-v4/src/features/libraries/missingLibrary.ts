import type { LibrariesResponse } from '../../api/types'

/**
 * Where a tab goes when its own library is gone (deleted in another tab or in
 * V3.5, or a stale id stored at launch), in V3.5's order: the server's current
 * library when it is listed, else the first listed, else main. Null while the
 * list is not loaded, while the tab's library is listed, or when there is
 * nowhere else to go.
 */
export function replacementLibrary(current: string, list: LibrariesResponse | undefined): string | null {
  if (!list) return null
  const ids = list.libraries.map((l) => l.id)
  if (ids.includes(current)) return null
  const next = ids.includes(list.current_id) ? list.current_id : (ids[0] ?? 'main')
  return next === current ? null : next
}
