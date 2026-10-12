import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useT } from '../../i18n'
import { pointIn, toPagePx } from '../../lib/uiScale'
import { isNoAdjust } from './adjust'
import { useAdjustDraft } from './adjustDraft'
import styles from './CanvasView.module.css'
import { ChangesOverlay } from './ChangesOverlay'
import { FastPreview } from './FastPreview'
import { downscale, FAST_PREVIEW_PIXELS, FAST_PREVIEW_TARGET, LARGE_PICTURE_PIXELS, memoryEstimateGb, SETTLE_MS, useSettled } from './largePicture'
import { cloneOffsetFor, cloneSourceOf, setCloneSource, useCloneSource } from './clone'
import { appendBase, appendManual, farEnough, newOpId, roundPoint, type Op, type StrokeOp } from './ops'
import { createPainter, createScratch, newBaseCache, renderInto, renderOps, type BaseCache, type Painter, type Scratch } from './paint'
import { useCensorPanel } from './panel'
import { publishPixels } from './pixels'
import { cloneRaster, type Raster, type Rect } from './raster'
import { RegionOverlay } from './RegionOverlay'
import { loadOriginal } from './saving'
import { useCensorSettings } from './settings'
import { toImage, useCanvasView, ZOOM_STEP } from './view'

// The picture being censored. Holds the pixels (original + result) and turns
// pointer input into strokes: painted live into the result buffer, then
// handed up as a new op list when the pointer lets go. While the Adjust tab
// is open, its unapplied sliders are shown on the picture as a preview.

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
  cache: BaseCache
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
        setLoad({ id: imageId, load: { state: 'ready', original, result, image, scratch, cache: newBaseCache() } })
      },
      (error: Error) => live && setLoad({ id: imageId, load: { state: 'error', reason: error.message } }),
    )
    return () => {
      live = false
    }
  }, [imageId])
  return load.id === imageId ? load.load : { state: 'loading' }
}

/**
 * The picture without the filter being tried, made small, for the fast preview
 * of a big picture: from the pixels on screen when they have no preview in
 * them, else rendered once from the ops (kept while the ops stay the same).
 */
function smallComposite(ready: Loaded, ops: Op[], onScreen: Op[] | null, cache: { current: { ops: Op[]; raster: Raster } | null }): Raster {
  if (cache.current?.ops === ops) return cache.current.raster
  const full = onScreen === ops ? ready.result : renderOps(ready.original, ops)
  cache.current = { ops, raster: downscale(full, FAST_PREVIEW_TARGET) }
  return cache.current.raster
}

/** The clone stamp's sample point: the source, or (once a stroke fixed the offset) the pointer plus the offset. */
function placeCloneMark(mark: HTMLDivElement | null, imageId: number, vx: number, vy: number): void {
  const clone = cloneSourceOf(imageId)
  if (!mark || !clone.source) return
  const v = useCanvasView.getState()
  const [sx, sy] = clone.offset ? [vx + clone.offset[0] * v.z, vy + clone.offset[1] * v.z] : [v.tx + clone.source[0] * v.z, v.ty + clone.source[1] * v.z]
  mark.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -50%)`
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
  const markRef = useRef<HTMLDivElement>(null)
  const rendered = useRef<Op[] | null>(null)
  const base = useRef<Raster | null>(null)
  const drag = useRef<Drag>(null)
  const view = useCanvasView()
  const size = useCensorSettings((s) => s.size)
  const cloning = useCensorSettings((s) => s.tool === 'clone')
  const source = useCloneSource((s) => (s.imageId === imageId ? s.source : null))
  const tab = useCensorPanel((s) => s.tab)
  const showChanges = useCensorPanel((s) => s.showChanges)
  const draft = useAdjustDraft((s) => s.values)
  const ready = load.state === 'ready' ? load : null
  const pixels = ready ? ready.original.width * ready.original.height : 0
  const preview = tab === 'adjust' && !isNoAdjust(draft) ? draft : null
  // A big picture renders the full-size preview only once the slider rests; meanwhile a small copy shows it.
  const resting = useSettled(preview, pixels >= FAST_PREVIEW_PIXELS ? SETTLE_MS : 0)
  // Without a preview (none yet, or just applied) there is nothing to wait for.
  const settled = preview ? resting : null
  const shown = useMemo(() => (settled ? appendBase(ops, { type: 'adjust', id: 'preview', values: settled }) : ops), [ops, settled])
  const small = useRef<{ ops: Op[]; raster: Raster } | null>(null)
  const [largeSeen, setLargeSeen] = useState(false)

  // Draw the picture: fully when the image arrives or the list changed from outside (undo, redo, reset, a preview).
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!ready || !canvas || rendered.current === shown) return
    if (canvas.width !== ready.result.width || canvas.height !== ready.result.height) {
      canvas.width = ready.result.width
      canvas.height = ready.result.height
      useCanvasView.getState().setImage(ready.result.width, ready.result.height)
    }
    base.current = renderInto(ready.result, ready.original, shown, ready.scratch, ready.cache)
    canvas.getContext('2d')?.putImageData(ready.image, 0, 0)
    rendered.current = shown
    publishPixels(imageId, ready.result, ready.original)
  }, [ready, shown, imageId])

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
        v.zoomBy(Math.min(ZOOM_STEP, Math.max(1 / ZOOM_STEP, Math.exp(-e.deltaY * 0.002))), ...pointIn(el, e))
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

  /** The pointer inside the viewport, in page px (the view's own units, also under the interface zoom). */
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const el = viewportRef.current
    return el ? pointIn(el, e) : [0, 0]
  }

  const imagePoint = (e: { clientX: number; clientY: number }): [number, number] => {
    const [vx, vy] = local(e)
    const [x, y] = toImage(useCanvasView.getState(), vx, vy)
    return [roundPoint(x), roundPoint(y)]
  }

  const moveRing = (e: ReactPointerEvent) => {
    const [vx, vy] = local(e)
    const ring = ringRef.current
    if (ring) ring.style.transform = `translate(${vx}px, ${vy}px) translate(-50%, -50%)`
    placeCloneMark(markRef.current, imageId, vx, vy)
  }

  const startStroke = (e: ReactPointerEvent) => {
    if (!ready) return
    const s = useCensorSettings.getState()
    const [x, y] = imagePoint(e)
    if (s.tool === 'clone' && e.altKey) return setCloneSource(imageId, x, y)
    const offset = s.tool === 'clone' ? cloneOffsetFor(imageId, x, y) : null
    // Without a source the clone stamp has nothing to copy (the canvas says to Alt+click first).
    if (s.tool === 'clone' && !offset) return
    const stroke: StrokeOp = { type: 'stroke', id: newOpId(), tool: s.tool, style: s.style, size: s.size, block: s.block, color: s.color, opacity: s.opacity, points: [x, y] }
    const op: StrokeOp = offset ? { ...stroke, offset } : stroke
    const painter = createPainter(ready.result, base.current ?? ready.original, op, ready.scratch)
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
      useCanvasView.getState().panBy(toPagePx(e.clientX - d.x), toPagePx(e.clientY - d.y))
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
    rendered.current = settled ? appendBase(next, { type: 'adjust', id: 'preview', values: settled }) : next
    if (ready) publishPixels(imageId, ready.result, ready.original)
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
      {ready && preview && preview !== settled && (
        <FastPreview small={smallComposite(ready, ops, rendered.current, small)} values={preview} fullWidth={ready.result.width} view={view} />
      )}
      {ready && showChanges && <ChangesOverlay imageId={imageId} style={style} />}
      {ready && pixels > LARGE_PICTURE_PIXELS && !largeSeen && (
        <p className={styles.large} role="status" data-testid="censor-large-warning" onPointerDown={(e) => e.stopPropagation()}>
          {t('censor.large.warning', { mp: Math.round(pixels / 1e6), gb: memoryEstimateGb(pixels) })}
          <button type="button" className="btn btn-ghost" onClick={() => setLargeSeen(true)}>
            {t('censor.large.dismiss')}
          </button>
        </p>
      )}
      {ready && tab === 'review' && <RegionOverlay ops={ops} width={ready.result.width} height={ready.result.height} zoom={view.z} style={style} />}
      {ready && cloning && source && <div ref={markRef} className={styles.cloneMark} aria-hidden data-testid="censor-clone-source" />}
      {ready && cloning && !source && (
        <p className={styles.hint} role="status" data-testid="censor-clone-hint">
          {t('censor.clone.hint')}
        </p>
      )}
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
