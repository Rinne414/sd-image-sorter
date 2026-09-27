import { useLayoutEffect, type RefObject } from 'react'

// The Reader's info column keeps its place when the next image opens, as
// V3.5's reader did (image-reader/sections-scroll.js): the position is kept
// together with how far down it was, and on the next image it goes back to
// the same place, or further when the new details are longer.

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
 * (`shownKey`) are laid out, and again each time a part of them changes size
 * afterwards (V3.5 tried once more after 120 ms; the tag groups wait for the
 * server and can come later than that), until the user scrolls.
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
    // Every size change inside the column shows up as a change of one of its sections, or of the column.
    const sizes = new ResizeObserver(apply)
    const watch = (node: Node) => {
      if (node instanceof Element) sizes.observe(node)
    }
    sizes.observe(el)
    el.childNodes.forEach(watch)
    const sections = new MutationObserver((changes) => {
      for (const change of changes) change.addedNodes.forEach(watch)
      apply()
    })
    sections.observe(el, { childList: true })
    const stop = () => {
      sizes.disconnect()
      sections.disconnect()
    }
    for (const type of USER_SCROLL) el.addEventListener(type, stop, { passive: true })
    return () => {
      stop()
      for (const type of USER_SCROLL) el.removeEventListener(type, stop)
    }
  }, [ref, shownKey])
}
