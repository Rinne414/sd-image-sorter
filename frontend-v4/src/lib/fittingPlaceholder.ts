import { useLayoutEffect, useState, type RefObject } from 'react'

/** The first of `candidates` (longest first) whose width fits `room`; the last one when none does. */
export function pickFitting(candidates: readonly string[], widthOf: (text: string) => number, room: number): string {
  return candidates.find((text) => widthOf(text) <= room) ?? candidates[candidates.length - 1] ?? ''
}

/**
 * A placeholder that is never cut off: the longest of `candidates` that fits
 * inside the field, chosen again whenever the field changes width. `field`
 * changes when another element takes the ref (measured afresh).
 */
export function useFittingPlaceholder(ref: RefObject<HTMLInputElement | null>, candidates: readonly string[], field?: unknown): string {
  const [chosen, setChosen] = useState(candidates[0] ?? '')
  const key = candidates.join('\n')

  useLayoutEffect(() => {
    const el = ref.current
    const canvas = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
    const list = key.split('\n')
    if (!el || !canvas || typeof ResizeObserver === 'undefined') {
      setChosen(list[0] ?? '')
      return
    }
    const pick = () => {
      const cs = getComputedStyle(el)
      canvas.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      setChosen(pickFitting(list, (text) => canvas.measureText(text).width, room))
    }
    pick()
    const observer = new ResizeObserver(pick)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, key, field])

  return chosen
}
