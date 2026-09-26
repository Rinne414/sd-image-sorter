// Switching between V4 (/v4/) and V3.5 (/): the link names the open library
// (?library=<id>) and the app it opens reads it once, checks it against the
// libraries it knows, and drops it from the address. Pure; state/arrival.ts
// and features/libraries/useArrival.ts apply it.

import { namesPage } from './route'

const PARAM = 'library'

/** The library a switch link carries, or null when it carries none. */
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

/** A link into the other app that carries the open library. */
export function switchHref(path: string, libraryId: string): string {
  return `${path}?${PARAM}=${encodeURIComponent(libraryId)}`
}

/** The page to open when coming back: the one V4 was left from, unless the address names one. */
export function arrivalHash(hash: string, saved: string | null): string {
  return namesPage(hash) || !saved ? hash : saved
}
