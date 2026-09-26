import { useLayoutEffect, type RefObject } from 'react'

// The Reader's info column keeps its place when the next image opens, as
// V3.5's reader did (image-reader/sections-scroll.js): the position is kept
// together with how far down it was, and on the next image it goes back to
// the same place, or further when the new details are longer.

/** V3.5 applied the place again 120 ms later, for parts that grow after the first layout. */
const RESTORE_AGAIN_MS = 120

export interface ScrollPlace {
  top: number
  /** How far down, 0–1, of what could be scrolled. */
  ratio: number
}

export function snapshotOf(top: number, scrollHeight: number, clientHeight: number): ScrollPlace {
  const max = Math.max(0, scrollHeight - clientHeight)
  return { top, ratio: max > 0 ? top / max : 0 }
}

/** Where to scroll the new content to; null when it does not scroll. */
export function restoredTop(place: ScrollPlace, scrollHeight: number, clientHeight: number): number | null {
  const max = Math.max(0, scrollHeight - clientHeight)
  if (max <= 0) return null
  return Math.min(max, Math.max(place.top, place.ratio * max))
}

/** The last place, kept while the Reader is closed too (V3.5's reader stayed on the page). */
let kept: ScrollPlace | null = null

const USER_SCROLL = ['wheel', 'touchstart', 'mousedown', 'keydown'] as const

/** The column's onScroll: remember where it is. */
export function rememberScroll(el: HTMLElement): void {
  kept = snapshotOf(el.scrollTop, el.scrollHeight, el.clientHeight)
}

/**
 * Puts the column back in its place when the details of another image
 * (`shownKey`) are laid out: at once, after the layout settles and once more
 * a moment later, unless the user scrolls first.
 */
export function useKeptScroll(ref: RefObject<HTMLElement | null>, shownKey: string | null): void {
  useLayoutEffect(() => {
    const el = ref.current
    const place = kept
    if (!el || shownKey === null || !place) return
    const apply = () => {
      const top = restoredTop(place, el.scrollHeight, el.clientHeight)
      if (top !== null) el.scrollTop = top
    }
    apply()
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(apply)
    })
    const timer = window.setTimeout(apply, RESTORE_AGAIN_MS)
    const stop = () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
    for (const type of USER_SCROLL) el.addEventListener(type, stop, { passive: true })
    return () => {
      stop()
      for (const type of USER_SCROLL) el.removeEventListener(type, stop)
    }
  }, [ref, shownKey])
}
