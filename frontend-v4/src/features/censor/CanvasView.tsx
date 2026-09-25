import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useT } from '../../i18n'
import styles from './CanvasView.module.css'
import { appendManual, farEnough, newOpId, roundPoint, type Op, type StrokeOp } from './ops'
import { createPainter, createScratch, renderInto, type Painter, type Scratch } from './paint'
import { cloneRaster, type Raster, type Rect } from './raster'
import { loadOriginal } from './saving'
import { useCensorSettings } from './settings'
import { toImage, useCanvasView, ZOOM_STEP } from './view'

// The picture being censored. Holds the pixels (original + result) and turns
// pointer input into strokes: painted live into the result buffer, then
// handed up as a new op list when the pointer lets go.

let drawing = false

/** True while a stroke or a pan is in progress (keys that change the picture wait). */
export function isDrawing(): boolean {
  return drawing
}

interface Loaded {
  original: Raster
  result: Raster
  image: ImageData
  scratch: Scratch
}

type Load = { state: 'loading' } | { state: 'error'; reason: string } | ({ state: 'ready' } & Loaded)

/** The pixels of `imageId`; never another image's while it loads. */
function useLoaded(imageId: number): Load {
  const [load, setLoad] = useState<{ id: number; load: Load }>({ id: imageId, load: { state: 'loading' } })
  useEffect(() => {
    let live = true
    loadOriginal(imageId).then(
      (original) => {
        if (!live) return
        const result = cloneRaster(original)
        const image = new ImageData(result.data, result.width, result.height)
        const scratch = createScratch(original.width, original.height)
        setLoad({ id: imageId, load: { state: 'ready', original, result, image, scratch } })
      },
      (error: Error) => live && setLoad({ id: imageId, load: { state: 'error', reason: error.message } }),
    )
    return () => {
      live = false
    }
  }, [imageId])
  return load.id === imageId ? load.load : { state: 'loading' }
}

interface Stroke {
  op: StrokeOp
  painter: Painter
  /** It covered at least one pixel (a stroke wholly off the picture is not an edit). */
  touched: boolean
}

type Drag = { kind: 'stroke'; stroke: Stroke } | { kind: 'pan'; x: number; y: number } | null

interface Props {
  imageId: number
  ops: Op[]
  onCommit: (ops: Op[]) => void
}

export function CanvasView({ imageId, ops, onCommit }: Props) {
  const t = useT()
  const load = useLoaded(imageId)
  const viewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ringRef = useRef<HTMLDivElement>(null)
  const rendered = useRef<Op[] | null>(null)
  const drag = useRef<Drag>(null)
  const view = useCanvasView()
  const size = useCensorSettings((s) => s.size)
  const ready = load.state === 'ready' ? load : null

  // Draw the picture: fully when the image arrives or the list changed from outside (undo, redo, reset).
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!ready || !canvas || rendered.current === ops) return
    if (canvas.width !== ready.result.width || canvas.height !== ready.result.height) {
      canvas.width = ready.result.width
      canvas.height = ready.result.height
      useCanvasView.getState().setImage(ready.result.width, ready.result.height)
    }
    renderInto(ready.result, ready.original, ops, ready.scratch)
    canvas.getContext('2d')?.putImageData(ready.image, 0, 0)
    rendered.current = ops
  }, [ready, ops])

  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const report = () => useCanvasView.getState().setViewport(el.clientWidth, el.clientHeight)
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Ctrl+wheel zooms around the pointer; the wheel alone scrolls the picture.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const v = useCanvasView.getState()
      if (e.ctrlKey || e.metaKey) {
        const box = el.getBoundingClientRect()
        v.zoomBy(Math.min(ZOOM_STEP, Math.max(1 / ZOOM_STEP, Math.exp(-e.deltaY * 0.002))), e.clientX - box.left, e.clientY - box.top)
      } else {
        v.panBy(e.shiftKey ? -e.deltaY : -e.deltaX, e.shiftKey ? 0 : -e.deltaY)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => () => {
    drawing = false
  }, [])

  const blit = (rect: Rect | null): boolean => {
    if (rect && ready) canvasRef.current?.getContext('2d')?.putImageData(ready.image, 0, 0, rect.x, rect.y, rect.w, rect.h)
    return rect !== null
  }

  const local = (e: { clientX: number; clientY: number }) => {
    const box = viewportRef.current?.getBoundingClientRect()
    return box ? [e.clientX - box.left, e.clientY - box.top] : [0, 0]
  }

  const imagePoint = (e: { clientX: number; clientY: number }): [number, number] => {
    const [vx, vy] = local(e)
    const [x, y] = toImage(useCanvasView.getState(), vx as number, vy as number)
    return [roundPoint(x), roundPoint(y)]
  }

  const moveRing = (e: ReactPointerEvent) => {
    const ring = ringRef.current
    if (!ring) return
    const [vx, vy] = local(e)
    ring.style.transform = `translate(${vx}px, ${vy}px) translate(-50%, -50%)`
  }

  const startStroke = (e: ReactPointerEvent) => {
    if (!ready) return
    const s = useCensorSettings.getState()
    const [x, y] = imagePoint(e)
    const op: StrokeOp = { type: 'stroke', id: newOpId(), tool: s.tool, style: s.style, size: s.size, block: s.block, color: s.color, opacity: s.opacity, points: [x, y] }
    const painter = createPainter(ready.result, ready.original, op, ready.scratch)
    const touched = blit(painter.add([x, y]))
    drag.current = { kind: 'stroke', stroke: { op, painter, touched } }
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current) return
    const panning = e.button === 1 || (e.button === 0 && useCanvasView.getState().panKey)
    if (!panning && e.button !== 0) return
    e.preventDefault()
    // Keys (tools, undo, arrows) go to the editor again, not to the slider used last.
    e.currentTarget.focus({ preventScroll: true })
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing = true
    if (panning) {
      drag.current = { kind: 'pan', x: e.clientX, y: e.clientY }
      e.currentTarget.dataset.cursor = 'grabbing'
    } else startStroke(e)
    if (!drag.current) drawing = false
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    moveRing(e)
    const d = drag.current
    if (d?.kind === 'pan') {
      useCanvasView.getState().panBy(e.clientX - d.x, e.clientY - d.y)
      drag.current = { kind: 'pan', x: e.clientX, y: e.clientY }
    } else if (d?.kind === 'stroke') {
      const { op, painter } = d.stroke
      const added: number[] = []
      const samples = e.nativeEvent.getCoalescedEvents?.() ?? []
      for (const sample of samples.length ? samples : [e.nativeEvent]) {
        const [x, y] = imagePoint(sample)
        if (!farEnough(op.points, x, y, op.size)) continue
        op.points.push(x, y)
        added.push(x, y)
      }
      if (added.length && blit(painter.add(added))) d.stroke.touched = true
    }
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    drag.current = null
    drawing = false
    e.currentTarget.dataset.cursor = cursor
    if (d?.kind !== 'stroke' || !d.stroke.touched) return
    const next = appendManual(ops, { ...d.stroke.op, points: [...d.stroke.op.points] })
    rendered.current = next
    onCommit(next)
  }

  const cursor = view.panKey ? 'grab' : 'paint'
  const style = ready
    ? { width: ready.result.width, height: ready.result.height, transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.z})` }
    : undefined

  return (
    <div
      ref={viewportRef}
      className={styles.viewport}
      tabIndex={-1}
      data-cursor={cursor}
      data-testid="censor-viewport"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerEnter={(e) => {
        moveRing(e)
        useCanvasView.getState().setHover(true)
      }}
      onPointerLeave={() => useCanvasView.getState().setHover(false)}
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
      onContextMenu={(e) => drag.current && e.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        style={style}
        hidden={!ready}
        data-pixelated={view.z >= 2 || undefined}
        data-testid="censor-canvas"
      />
      {load.state === 'loading' && <p className={styles.note}>{t('censor.loading')}</p>}
      {load.state === 'error' && (
        <p className={styles.note} role="alert">
          {t('censor.loadFailed', { reason: load.reason })}
        </p>
      )}
      {ready && cursor === 'paint' && (
        <div ref={ringRef} className={styles.ring} style={{ width: size * view.z, height: size * view.z }} aria-hidden data-hover={view.hover || undefined} />
      )}
    </div>
  )
}
