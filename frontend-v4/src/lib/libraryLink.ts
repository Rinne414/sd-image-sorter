// A link can name the library to open: ?library=<id>. Old V3.5 bookmarks
// carry it too, since / redirects to /v4/ with its query. The app reads it
// once, checks it against the libraries it knows, and drops it from the
// address. Pure; state/arrival.ts and features/libraries/useArrival.ts apply it.

const PARAM = 'library'

/** The library a link carries, or null when it carries none. */
export function libraryParam(search: string): string | null {
  const value = new URLSearchParams(search).get(PARAM)?.trim()
  return value ? value : null
}

/** The address search without `library=`; every other part stays as written. */
export function withoutLibraryParam(search: string): string {
  const parts = search
    .replace(/^\?/, '')
    .split('&')
    .filter((part) => part !== '' && keyOf(part) !== PARAM)
  return parts.length > 0 ? `?${parts.join('&')}` : ''
}

function keyOf(part: string): string {
  const key = part.split('=')[0] ?? ''
  try {
    return decodeURIComponent(key)
  } catch {
    return key
  }
}

/** The library to switch to on arrival: the carried one when it exists here and is not already open. */
export function arrivalLibrary(carried: string | null, known: readonly string[], current: string): string | null {
  if (carried === null || carried === current) return null
  return known.includes(carried) ? carried : null
}
