import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import { uiZoom } from '../../lib/uiScale'
import { boxOf, contentAt, edgeScroll, hitKeys, isDrag, marqueeSelection, onContent, tileRectIn, type Point, type Rect, type TileRect } from './marquee'
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

const scrollOf = (el: HTMLElement) => ({ left: el.scrollLeft, top: el.scrollTop })

/** The pointer in the grid's scrolled content, in page px (the interface zoom taken out). */
function contentPoint(el: HTMLElement, clientX: number, clientY: number): Point {
  return contentAt(clientX, clientY, el.getBoundingClientRect(), scrollOf(el), uiZoom())
}

/** A press the box may start from: the main button on the grid's own background, not on its scrollbar. */
function startsBox(e: PointerEvent<HTMLElement>, el: HTMLElement): boolean {
  if (e.button !== 0 || (e.target as Element).closest('[data-key], button, input, a, label')) return false
  return onContent(e.clientX, e.clientY, el.getBoundingClientRect(), { width: el.clientWidth, height: el.clientHeight }, uiZoom())
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

/** Every rendered tile's place in the scrolled content, in page px (for grids that draw all their tiles). */
export function renderedTileRects(el: HTMLElement | null): TileRect[] {
  if (!el) return []
  const r = el.getBoundingClientRect()
  const zoom = uiZoom()
  return [...el.querySelectorAll<HTMLElement>('[data-key]')].map((tile) => ({
    key: tile.dataset.key ?? '',
    rect: tileRectIn(tile.getBoundingClientRect(), r, scrollOf(el), zoom),
  }))
}
