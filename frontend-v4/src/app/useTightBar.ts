import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { uiZoom } from '../lib/uiScale'

/** Free width a top bar keeps for the items that come and go: the AI busy chip, the update hint and Jobs. */
export const BAR_ROOM = 200

const width = (el: Element | null | undefined) => (el ? el.getBoundingClientRect().width : 0)

/**
 * True when the bar is short of that room (many places in the bar, a wide
 * font): the brand then shows only its mark. The room is the gap plus whatever
 * of the coming-and-going items shows now (everything between `gap` and
 * `until`), so their appearing never flips it. It flips back only once the
 * whole brand fits again with the room kept.
 */
export function useTightBar(
  gap: RefObject<HTMLElement | null>,
  until: RefObject<HTMLElement | null>,
  brand: RefObject<HTMLElement | null>,
): boolean {
  const [tight, setTight] = useState(false)
  const fullBrand = useRef(0)

  useLayoutEffect(() => {
    const el = gap.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const check = () => {
      let room = width(el)
      for (let next = el.nextElementSibling; next && next !== until.current; next = next.nextElementSibling) room += width(next)
      if (!tight) {
        fullBrand.current = width(brand.current)
        if (room / uiZoom() < BAR_ROOM) setTight(true)
      } else if ((room - (fullBrand.current - width(brand.current))) / uiZoom() >= BAR_ROOM) {
        setTight(false)
      }
    }
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [gap, until, brand, tight])

  return tight
}
