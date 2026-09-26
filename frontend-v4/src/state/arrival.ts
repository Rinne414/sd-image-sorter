import { arrivalHash, libraryParam, switchHref, withoutLibraryParam } from '../lib/appSwitch'

// Coming from V3.5's "试用新版界面（V4）" (or back from it): runs once, before
// the store reads the address. The carried library waits here until the
// libraries list can vouch for it (features/libraries/useArrival.ts); the
// address loses `library=` at once, so a reload does not apply it again.

/** Where V4 was when the user left it for V3.5 (this tab only). */
const RETURN_KEY = 'sd-v4-return-route'

function takeSaved(): string | null {
  try {
    const saved = sessionStorage.getItem(RETURN_KEY)
    sessionStorage.removeItem(RETURN_KEY)
    return saved
  } catch {
    return null
  }
}

function take(): string | null {
  const saved = takeSaved()
  const { pathname, search, hash } = window.location
  if (!new URLSearchParams(search).has('library')) return null
  const address = pathname + withoutLibraryParam(search) + arrivalHash(hash, saved)
  history.replaceState(history.state, '', address)
  return libraryParam(search)
}

let carried = take()

/** The library the switch link named, handed out once. */
export function takeCarriedLibrary(): string | null {
  const id = carried
  carried = null
  return id
}

/** Remember the page on screen, so coming back from V3.5 reopens it. */
export function rememberRoute(): void {
  try {
    sessionStorage.setItem(RETURN_KEY, window.location.hash)
  } catch {
    // storage blocked: V4 reopens on its first page
  }
}

/** V3.5's address with this library: the href of every "back to V3.5" link. */
export const v35Href = (libraryId: string): string => switchHref('/', libraryId)

/** Go to V3.5 in this library (Ctrl K), remembering the page on screen. */
export function leaveForV35(libraryId: string): void {
  rememberRoute()
  window.location.assign(v35Href(libraryId))
}
