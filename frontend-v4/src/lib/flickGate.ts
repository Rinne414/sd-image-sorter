/**
 * Tells whether the gallery is being flung, so tiles drawn mid-flick wait for
 * their picture until it settles. A fast flick at 100,000 pictures asked for
 * 245 to 255 thumbnails in two seconds, none cancelled, and the tiles left on
 * screen waited 3 to 4 s behind them (measured 2026-11-08). The same rule as
 * the classic gallery's gallery/thumb-gate.js.
 */

/** Faster than this is a flick, not reading: about two screens a second. */
export const FAST_PX_PER_MS = 2.5
/** Settled after this long without a scroll event, if the position stayed put. */
export const SETTLE_MS = 120
/** A flick stays a flick until it has moved slowly for this long (smooth scrolling eases each step). */
export const SLOW_HOLD_MS = 150

export interface FlickGateOptions {
  getScrollTop: () => number
  /** Called when the gallery starts or stops being flung. */
  onChange: (isFlinging: boolean) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
}

export interface FlickGate {
  /** Call on every scroll event of the gallery's scroller. */
  noteScroll: () => void
  isFlinging: () => boolean
  dispose: () => void
}

export function createFlickGate(options: FlickGateOptions): FlickGate {
  const now = options.now ?? (() => performance.now())
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => window.setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((id: unknown) => window.clearTimeout(id as number))
  let lastTop: number | null = null
  let lastAt = 0
  let flinging = false
  let slowSince: number | null = null
  let timer: unknown = null

  const setFlinging = (next: boolean) => {
    if (next === flinging) return
    flinging = next
    options.onChange(next)
  }

  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  // A busy frame can hold scroll events back past the timer (166 ms seen
  // mid-flick): only a position that stayed put means the gallery stopped.
  const settle = () => {
    timer = null
    if (lastTop !== null && Math.abs(options.getScrollTop() - lastTop) > 1) {
      timer = setTimer(settle, SETTLE_MS)
      return
    }
    slowSince = null
    setFlinging(false)
  }

  return {
    noteScroll() {
      const top = options.getScrollTop()
      const at = now()
      // The first event after a pause starts afresh: a single jump (a click on
      // the scrollbar, End, a restored position) loads at once, while dragging
      // the scrollbar thumb sends a stream of events and counts as a flick.
      if (lastTop !== null && at > lastAt && at - lastAt <= SETTLE_MS) {
        const speed = Math.abs(top - lastTop) / (at - lastAt)
        if (speed > FAST_PX_PER_MS) {
          slowSince = null
          setFlinging(true)
        } else if (flinging) {
          if (slowSince === null) slowSince = at
          if (at - slowSince >= SLOW_HOLD_MS) {
            // Down to a reading pace while still moving: show what is there.
            slowSince = null
            setFlinging(false)
          }
        }
      }
      lastTop = top
      lastAt = at
      cancelTimer()
      timer = setTimer(settle, SETTLE_MS)
    },
    isFlinging: () => flinging,
    dispose: cancelTimer,
  }
}
