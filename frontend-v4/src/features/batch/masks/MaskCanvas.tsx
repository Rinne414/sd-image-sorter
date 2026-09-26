import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { imageFileUrl } from '../../../api/urls'
import { pointIn, toPagePx } from '../../../lib/uiScale'
import { farEnough, roundPoint } from '../../censor/ops'
import { createPainter, createScratch, type Painter } from '../../censor/paint'
import { createRaster, type Raster, type Rect } from '../../censor/raster'
import { fitView, toImage, zoomAt, ZOOM_STEP, type View } from '../../censor/view'
import styles from './MaskEditor.module.css'
import { renderInto, strokeOp, type MaskState, type MaskStroke, type MaskTool } from './maskModel'

// The picture with its training mask over it (the parts left out darkened),
// painted with the censor editor's painter and view maths. The mask pixels
// live here; a finished stroke is handed up as an action.

interface Props {
  imageId: number
  width: number
  height: number
  state: MaskState
  tool: MaskTool
  size: number
  panKey: boolean
  onStroke: (action: MaskStroke) => void
  /** The current mask pixels, for saving (kept up to date after every stroke). */
  onPixels: (mask: Raster) => void
  /** Zoom commands from the tool panel: 'fit', 'in', 'out', '1:1'; `n` changes each time one is given. */
  command: { kind: 'fit' | 'in' | 'out' | 'actual'; n: number } | null
}

type Drag = { kind: 'stroke'; action: MaskStroke; painter: Painter; touched: boolean } | { kind: 'pan'; x: number; y: number } | null

function useViewport(ref: React.RefObject<HTMLDivElement | null>, width: number, height: number) {
  const [view, setView] = useState<View & { fitted: boolean }>({ z: 1, tx: 0, ty: 0, fitted: true })
  const size = useRef({ vw: 0, vh: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const report = () => {
      size.current = { vw: el.clientWidth, vh: el.clientHeight }
      setView((v) => (v.fitted ? { ...fitView(el.clientWidth, el.clientHeight, width, height), fitted: true } : v))
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, width, height])
  const fit = () => setView({ ...fitView(size.current.vw, size.current.vh, width, height), fitted: true })
  const zoom = (factor: number, cx = size.current.vw / 2, cy = size.current.vh / 2) => setView((v) => ({ ...zoomAt(v, factor, cx, cy), fitted: false }))
  const actual = () => setView({ z: 1, tx: (size.current.vw - width) / 2, ty: (size.current.vh - height) / 2, fitted: false })
  const pan = (dx: number, dy: number) => setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy, fitted: false }))
  return { view, fit, zoom, actual, pan }
}

export function MaskCanvas({ imageId, width, height, state, tool, size, panKey, onStroke, onPixels, command }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ringRef = useRef<HTMLDivElement>(null)
  const mask = useRef<{ raster: Raster; image: ImageData; scratch: ReturnType<typeof createScratch> } | null>(null)
  const drawn = useRef<MaskState | null>(null)
  /** The stroke last handed up: already on the pixels, so the state that adds it needs no redraw. */
  const handed = useRef<MaskStroke | null>(null)
  const drag = useRef<Drag>(null)
  const { view, fit, zoom, actual, pan } = useViewport(viewportRef, width, height)
  const [hover, setHover] = useState(false)

  // Redraw the whole mask when the state changes from outside (a load, undo, invert, an automatic mask).
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || drawn.current === state) return
    const last = drawn.current
    if (last && handed.current && state.base === last.base && state.actions.length === last.actions.length + 1 && state.actions.at(-1) === handed.current) {
      drawn.current = state
      handed.current = null
      return
    }
    if (!mask.current || mask.current.raster.width !== width || mask.current.raster.height !== height) {
      const raster = createRaster(width, height)
      mask.current = { raster, image: new ImageData(raster.data, width, height), scratch: createScratch(width, height) }
      canvas.width = width
      canvas.height = height
    }
    renderInto(mask.current.raster, state, mask.current.scratch)
    canvas.getContext('2d')?.putImageData(mask.current.image, 0, 0)
    drawn.current = state
    onPixels(mask.current.raster)
  }, [state, width, height, onPixels])

  useEffect(() => {
    if (!command) return
    if (command.kind === 'fit') fit()
    else if (command.kind === 'actual') actual()
    else zoom(command.kind === 'in' ? ZOOM_STEP : 1 / ZOOM_STEP)
    // A command runs once, when it is given (the view functions change every render).
  }, [command])

  // Ctrl+wheel zooms around the pointer; the wheel alone moves the picture.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        zoom(Math.min(ZOOM_STEP, Math.max(1 / ZOOM_STEP, Math.exp(-e.deltaY * 0.002))), ...pointIn(el, e))
      } else pan(e.shiftKey ? -e.deltaY : -e.deltaX, e.shiftKey ? 0 : -e.deltaY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  const blit = (rect: Rect | null): boolean => {
    const m = mask.current
    if (rect && m) canvasRef.current?.getContext('2d')?.putImageData(m.image, 0, 0, rect.x, rect.y, rect.w, rect.h)
    return rect !== null
  }

  /** The pointer inside the viewport, in page px (the view's own units, also under the interface zoom). */
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const el = viewportRef.current
    return el ? pointIn(el, e) : [0, 0]
  }

  const imagePoint = (e: { clientX: number; clientY: number }): [number, number] => {
    const [x, y] = toImage(view, ...local(e))
    return [roundPoint(x), roundPoint(y)]
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const m = mask.current
    if (drag.current || !m) return
    const panning = e.button === 1 || (e.button === 0 && panKey)
    if (!panning && e.button !== 0) return
    e.preventDefault()
    e.currentTarget.focus({ preventScroll: true })
    e.currentTarget.setPointerCapture(e.pointerId)
    if (panning) {
      drag.current = { kind: 'pan', x: e.clientX, y: e.clientY }
      return
    }
    const [x, y] = imagePoint(e)
    const action: MaskStroke = { kind: 'stroke', tool, size, points: [x, y] }
    const painter = createPainter(m.raster, m.raster, strokeOp(action), m.scratch)
    drag.current = { kind: 'stroke', action, painter, touched: blit(painter.add([x, y])) }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ring = ringRef.current
    if (ring) ring.style.transform = `translate(${local(e)[0]}px, ${local(e)[1]}px) translate(-50%, -50%)`
    const d = drag.current
    if (d?.kind === 'pan') {
      pan(toPagePx(e.clientX - d.x), toPagePx(e.clientY - d.y))
      drag.current = { kind: 'pan', x: e.clientX, y: e.clientY }
    } else if (d?.kind === 'stroke') {
      const added: number[] = []
      const samples = e.nativeEvent.getCoalescedEvents?.() ?? []
      for (const sample of samples.length ? samples : [e.nativeEvent]) {
        const [x, y] = imagePoint(sample)
        if (!farEnough(d.action.points, x, y, d.action.size)) continue
        d.action.points.push(x, y)
        added.push(x, y)
      }
      if (added.length && blit(d.painter.add(added))) d.touched = true
    }
  }

  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (d?.kind !== 'stroke' || !d.touched || !mask.current) return
    onPixels(mask.current.raster)
    const done: MaskStroke = { ...d.action, points: [...d.action.points] }
    handed.current = done
    onStroke(done)
  }

  const box = { width, height, transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.z})` }
  return (
    <div
      ref={viewportRef}
      className={styles.viewport}
      tabIndex={-1}
      data-cursor={panKey ? 'grab' : 'paint'}
      data-testid="mask-viewport"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
    >
      <img className={styles.picture} src={imageFileUrl(imageId)} alt="" draggable={false} style={box} data-pixelated={view.z >= 2 || undefined} />
      <canvas ref={canvasRef} className={styles.mask} style={box} data-pixelated={view.z >= 2 || undefined} data-testid="mask-canvas" />
      {!panKey && <div ref={ringRef} className={styles.ring} style={{ width: size * view.z, height: size * view.z }} data-hover={hover || undefined} aria-hidden />}
    </div>
  )
}
