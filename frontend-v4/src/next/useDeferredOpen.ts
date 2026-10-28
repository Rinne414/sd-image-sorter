import { useEffect, useState } from 'react'

/** Long enough for a double-click's second click (most land within 300 ms). */
export const DOUBLE_CLICK_MS = 400

/**
 * `open`, but turning on only after `delayMs` (turning off at once). The recipe
 * column narrows the grid when it opens; opened by a click at once, it moved
 * the tiles under the pointer, so a double-click's second click landed on
 * another picture or on nothing.
 */
export function useDeferredOpen(open: boolean, delayMs: number = DOUBLE_CLICK_MS): boolean {
  const [shown, setShown] = useState(open)
  useEffect(() => {
    if (!open) {
      setShown(false)
      return
    }
    const timer = window.setTimeout(() => setShown(true), delayMs)
    return () => window.clearTimeout(timer)
  }, [open, delayMs])
  return open && shown
}
