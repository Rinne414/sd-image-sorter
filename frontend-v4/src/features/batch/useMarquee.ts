import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import { boxOf, edgeScroll, hitKeys, isDrag, marqueeSelection, type Point, type Rect, type TileRect } from './marquee'
import type { PickSelection } from './pickLogic'

// Drives a box selection over a batch grid's scroller (see marquee.ts): a
// press on empty space, then a drag; the grid scrolls when the pointer nears
// its top or bottom edge. Tiles (anything with data-key), buttons and inputs
// keep their own clicks and drags.

interface Options {
  scrollRef: RefObject<HTMLElement | null>
  /** Every tile's place in the scrolled content, read each time the box changes. */
  tiles: () => TileRect[]
  selection: PickSelection
  onSelect: (next: PickSelection) => void
}

interface Drag {
  pointerId: number
  start: Point
  clientX: number
  clientY: number
  base: PickSelection
  boxing: boolean
  frame: number
}

function contentPoint(el: HTMLElement, clientX: number, clientY: number): Point {
  const r = el.getBoundingClientRect()
  return { x: clientX - r.left + el.scrollLeft, y: clientY - r.top + el.scrollTop }
}

/** A press the box may start from: the main button on the grid's own background, not on its scrollbar. */
function startsBox(e: PointerEvent<HTMLElement>, el: HTMLElement): boolean {
  if (e.button !== 0 || (e.target as Element).closest('[data-key], button, input, a, label')) return false
  const r = el.getBoundingClientRect()
  return e.clientX - r.left < el.clientWidth && e.clientY - r.top < el.clientHeight
}

export function useMarquee({ scrollRef, tiles, selection, onSelect }: Options) {
  const [box, setBox] = useState<Rect | null>(null)
  const drag = useRef<Drag | null>(null)
  const latest = useRef({ tiles, onSelect })
  useLayoutEffect(() => {
    latest.current = { tiles, onSelect }
  })

  const update = () => {
    const d = drag.current
    const el = scrollRef.current
    if (!d || !el) return
    const now = contentPoint(el, d.clientX, d.clientY)
    if (!d.boxing && !isDrag(d.start, now)) return
    d.boxing = true
    const next = boxOf(d.start, now)
    setBox(next)
    latest.current.onSelect(marqueeSelection(d.base, hitKeys(latest.current.tiles(), next)))
  }

  const tick = () => {
    const d = drag.current
    const el = scrollRef.current
    if (!d || !el) return
    if (d.boxing) {
      const r = el.getBoundingClientRect()
      const step = edgeScroll(d.clientY, r.top, r.bottom)
      if (step !== 0) {
        el.scrollTop += step
        update()
      }
    }
    d.frame = requestAnimationFrame(tick)
  }

  const stop = () => {
    if (drag.current) cancelAnimationFrame(drag.current.frame)
    drag.current = null
    setBox(null)
  }
  // Leaving the step mid-drag: no frame keeps running.
  useEffect(
    () => () => {
      if (drag.current) cancelAnimationFrame(drag.current.frame)
    },
    [],
  )

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    const el = scrollRef.current
    if (!el || !startsBox(e, el)) return
    e.preventDefault()
    el.focus({ preventScroll: true })
    el.setPointerCapture(e.pointerId)
    const start = contentPoint(el, e.clientX, e.clientY)
    drag.current = { pointerId: e.pointerId, start, clientX: e.clientX, clientY: e.clientY, base: selection, boxing: false, frame: requestAnimationFrame(tick) }
  }

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    d.clientX = e.clientX
    d.clientY = e.clientY
    update()
  }

  const onEnd = (e: PointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId === e.pointerId) stop()
  }

  return {
    box,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onEnd,
      onPointerCancel: onEnd,
      onLostPointerCapture: onEnd,
      onScroll: () => {
        if (drag.current?.boxing) update()
      },
    },
  }
}

/** Every rendered tile's place in the scrolled content (for grids that draw all their tiles). */
export function renderedTileRects(el: HTMLElement | null): TileRect[] {
  if (!el) return []
  const r = el.getBoundingClientRect()
  return [...el.querySelectorAll<HTMLElement>('[data-key]')].map((tile) => {
    const t = tile.getBoundingClientRect()
    const left = t.left - r.left + el.scrollLeft
    const top = t.top - r.top + el.scrollTop
    return { key: tile.dataset.key ?? '', rect: { left, top, right: left + t.width, bottom: top + t.height } }
  })
}
