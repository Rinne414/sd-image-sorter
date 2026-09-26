import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from 'react'
import { toPagePx } from '../../lib/uiScale'
import { FIT, fittedSize, isFit, panBy, percentOfOriginal, toggleZoom, wheelFactor, zoomAt, type Frame, type Point, type Size, type View } from './zoom'

// The big image's zoom: the wheel zooms around the pointer (past the original
// size), a drag pans, a click (or Z) goes between fitted and the original size.
// A new image always starts fitted.

interface Options {
  id: number | null
  /** The visible area; its centre is the zoom's origin. */
  stageRef: RefObject<HTMLElement | null>
  /** The box the picture is fitted into (measured without the zoom transform). */
  wrapRef: RefObject<HTMLElement | null>
  /** The picture's own pixel size, once known. */
  natural: () => Size | null
}

/** Movement that still counts as a click, not a drag. */
const CLICK_SLOP = 4

export function useZoom({ id, stageRef, wrapRef, natural }: Options) {
  const [state, setState] = useState<{ id: number | null; view: View }>({ id: null, view: FIT })
  const [, setResized] = useState(0)
  const [dragging, setDragging] = useState(false)
  const view = state.id === id ? state.view : FIT
  const viewRef = useRef(view)
  viewRef.current = view
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const swallowClick = useRef(false)

  const naturalRef = useRef(natural)
  naturalRef.current = natural

  // Reads only refs, so the wheel listener (added once per image) always measures the present.
  const frame = (): Frame | null => {
    const stage = stageRef.current
    const wrap = wrapRef.current
    const size = naturalRef.current()
    if (!stage || !wrap || !size || size.w <= 0 || size.h <= 0 || wrap.offsetWidth <= 0) return null
    const fitted = fittedSize(size, { w: wrap.offsetWidth, h: wrap.offsetHeight })
    return { stage: { w: stage.clientWidth, h: stage.clientHeight }, fitted, original: size.w / fitted.w }
  }

  const pointOf = (e: { clientX: number; clientY: number }): Point => {
    const r = stageRef.current?.getBoundingClientRect()
    // page px, like the frame sizes (screen px differ under the interface zoom)
    return r ? { x: toPagePx(e.clientX - (r.left + r.width / 2)), y: toPagePx(e.clientY - (r.top + r.height / 2)) } : { x: 0, y: 0 }
  }

  const set = (next: View) => setState({ id, view: next })

  // Native and not passive: a React wheel handler cannot stop the page from scrolling.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage || id === null) return
    const onWheel = (e: WheelEvent) => {
      const f = frame()
      if (!f) return
      e.preventDefault()
      setState((s) => ({ id, view: zoomAt(s.id === id ? s.view : FIT, wheelFactor(e.deltaY, e.deltaMode), pointOf(e), f) }))
    }
    const resize = new ResizeObserver(() => setResized((n) => n + 1))
    resize.observe(stage)
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      stage.removeEventListener('wheel', onWheel)
      resize.disconnect()
    }
    // frame and pointOf read refs only
  }, [id, stageRef])

  const toggle = (at: Point = { x: 0, y: 0 }) => {
    const f = frame()
    if (f) set(toggleZoom(viewRef.current, at, f))
  }

  const handlers = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || isFit(viewRef.current)) return
      drag.current = { x: e.clientX, y: e.clientY, moved: false }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const d = drag.current
      if (!d) return
      const dx = e.clientX - d.x
      const dy = e.clientY - d.y
      if (!d.moved && Math.hypot(dx, dy) < CLICK_SLOP) return
      if (!d.moved) setDragging(true)
      drag.current = { x: e.clientX, y: e.clientY, moved: true }
      const f = frame()
      if (f) set(panBy(viewRef.current, toPagePx(dx), toPagePx(dy), f))
    },
    onPointerUp: () => {
      if (drag.current?.moved) swallowClick.current = true
      drag.current = null
      setDragging(false)
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      e.stopPropagation()
      if (swallowClick.current) {
        swallowClick.current = false
        return
      }
      toggle(pointOf(e))
    },
  }

  const f = frame()
  return {
    view,
    zoomed: !isFit(view),
    dragging,
    /** Percent of the picture's own size; null until the size is known. */
    percent: f ? percentOfOriginal(view, f) : null,
    toggle,
    handlers: { ...handlers, onPointerCancel: handlers.onPointerUp },
  }
}
