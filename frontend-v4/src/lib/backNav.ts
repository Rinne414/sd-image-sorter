// Browser Back and the mouse back button go up one level, like Esc: the
// topmost layer (lightbox, dialog, menu) closes first; otherwise the page
// shown before comes back. Forward returns to where the user had been.
//
// Only a change of page adds a history entry. The first page is the root:
// Back there would leave the program, so the first press only says so and a
// second one within a few seconds leaves.
//
// Entries are added only after the first key or click, so the browser treats
// them as the user's own and does not skip them on Back.

const MARK = 'sdSorterPage'
export const ROOT_LEAVE_WINDOW_MS = 3000

type Mark = 'base' | 'page'

interface Hooks {
  /** Close the topmost layer; false when nothing was open. */
  closeTop: () => boolean
  /** Show the page the address names now. */
  showAddress: () => void
  /** Say that one more Back leaves the program. */
  warnLeave: () => void
}

let armed = false
let installed = false
let lastRootBackAt = 0
/** The address of the page on screen: where a Back that only closed a layer returns. */
let shownHash = typeof location === 'undefined' ? '' : location.hash

const markOf = (state: unknown): Mark | null => {
  const value = (state as Record<string, unknown> | null)?.[MARK]
  return value === 'base' || value === 'page' ? value : null
}

const entry = (mark: Mark) => ({ [MARK]: mark })

function arm(): void {
  if (armed) return
  armed = true
  // After a reload the entry is already ours.
  if (markOf(history.state) === 'page') return
  // Behind the first page, an entry to land on so Back can be answered.
  history.replaceState(entry('base'), '', location.href)
  history.pushState(entry('page'), '', location.href)
}

/** Show another page: a new history entry once the user has acted, else the same one rewritten. */
export function pushPage(hash: string): void {
  if (location.hash === hash) return
  if (armed) history.pushState(entry('page'), '', hash)
  else history.replaceState(history.state, '', hash)
  shownHash = hash
}

/** Rewrite the address without a new entry (a page's own state, not a new page). */
export function replacePage(hash: string): void {
  if (location.hash !== hash) history.replaceState(history.state, '', hash)
  shownHash = hash
}

/** Answer Back and Forward. Call once, from the app shell. */
export function installBackNav(hooks: Hooks): () => void {
  if (installed) return () => {}
  installed = true
  shownHash = location.hash

  const onFirstInput = () => arm()
  const onPop = (e: PopStateEvent) => {
    if (!armed) {
      hooks.showAddress()
      shownHash = location.hash
      return
    }
    // A layer is open: Back closes it and the page stays.
    if (hooks.closeTop()) {
      history.pushState(entry('page'), '', shownHash || location.pathname)
      return
    }
    if (markOf(e.state) === 'base') {
      const now = Date.now()
      if (now - lastRootBackAt < ROOT_LEAVE_WINDOW_MS) {
        history.back()
        return
      }
      lastRootBackAt = now
      history.pushState(entry('page'), '', shownHash || location.pathname)
      hooks.warnLeave()
      return
    }
    hooks.showAddress()
    shownHash = location.hash
  }
  // An address typed or edited by hand.
  const onHash = () => {
    shownHash = location.hash
  }

  window.addEventListener('pointerdown', onFirstInput, { capture: true, once: true })
  window.addEventListener('keydown', onFirstInput, { capture: true, once: true })
  window.addEventListener('popstate', onPop)
  window.addEventListener('hashchange', onHash)
  return () => {
    installed = false
    window.removeEventListener('pointerdown', onFirstInput, { capture: true })
    window.removeEventListener('keydown', onFirstInput, { capture: true })
    window.removeEventListener('popstate', onPop)
    window.removeEventListener('hashchange', onHash)
  }
}
