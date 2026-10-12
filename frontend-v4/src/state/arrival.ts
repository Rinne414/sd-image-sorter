import { libraryParam, withoutLibraryParam } from '../lib/libraryLink'

// Arriving on a link that names a library (?library=): runs once, before the
// store reads the address. The carried library waits here until the
// libraries list can vouch for it (features/libraries/useArrival.ts); the
// address loses `library=` at once, so a reload does not apply it again.

function take(): string | null {
  const { pathname, search, hash } = window.location
  if (!new URLSearchParams(search).has('library')) return null
  history.replaceState(history.state, '', pathname + withoutLibraryParam(search) + hash)
  return libraryParam(search)
}

let carried = take()

/** The library the link named, handed out once. */
export function takeCarriedLibrary(): string | null {
  const id = carried
  carried = null
  return id
}
