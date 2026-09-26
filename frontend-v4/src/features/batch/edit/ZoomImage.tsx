import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { useT } from '../../../i18n'
import { toPagePx } from '../../../lib/uiScale'
import { Icon } from '../../../ui/Icon'
import styles from './EditStep.module.css'

const STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8]

/** The zoom step after `zoom` (up or down); `fit` is the scale that fits the frame. */
function nextZoom(zoom: number, dir: 1 | -1): number {
  if (dir > 0) return STEPS.find((z) => z > zoom + 1e-6) ?? STEPS[STEPS.length - 1]!
  return [...STEPS].reverse().find((z) => z < zoom - 1e-6) ?? STEPS[0]!
}

interface Props {
  src: string | null
  /** Shown when there is no picture to show. */
  missing: string
  testId?: string
}

/**
 * A picture that fits its frame, with − / + / fit and Ctrl+wheel zoom; when
 * zoomed in, drag (or scroll) moves around it. A new picture starts fitted.
 */
export function ZoomImage({ src, missing, testId }: Props) {
  const t = useT()
  const frame = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState<number | null>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)

  useEffect(() => {
    setZoom(null)
    setNatural(null)
  }, [src])

  const fitScale = () => {
    const el = frame.current
    if (!el || !natural) return 1
    return Math.min(el.clientWidth / natural.w, el.clientHeight / natural.h, 1)
  }
  const current = zoom ?? fitScale()
  const step = (dir: 1 | -1) => setZoom(nextZoom(current, dir))

  // Ctrl+wheel zooms the picture, not the page: a native listener, since React's wheel listener is passive.
  const stepRef = useRef(step)
  stepRef.current = step
  useEffect(() => {
    const el = frame.current
    if (!el) return
    const onWheel = (e: globalThis.WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      stepRef.current(e.deltaY < 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  const onDown = (e: PointerEvent) => {
    const el = frame.current
    if (zoom === null || !el || e.button !== 0) return
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop }
    el.setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent) => {
    const el = frame.current
    if (!drag.current || !el) return
    el.scrollLeft = drag.current.left - toPagePx(e.clientX - drag.current.x)
    el.scrollTop = drag.current.top - toPagePx(e.clientY - drag.current.y)
  }

  return (
    <div className={styles.zoomBox}>
      <div className={styles.zoomBar}>
        <button type="button" className="btn btn-ghost btn-icon" onClick={() => step(-1)} disabled={!natural} title={t('dataset.edit.zoomOut')} aria-label={t('dataset.edit.zoomOut')}>
          <Icon name="minus" size={14} />
        </button>
        <span className={`${styles.zoomValue} mono`} data-testid="edit-zoom-value">
          {natural ? `${Math.round(current * 100)}%` : '–'}
        </span>
        <button type="button" className="btn btn-ghost btn-icon" onClick={() => step(1)} disabled={!natural} title={t('dataset.edit.zoomIn')} aria-label={t('dataset.edit.zoomIn')} data-testid="edit-zoom-in">
          <Icon name="plus" size={14} />
        </button>
        <button type="button" className="btn btn-ghost btn-icon" onClick={() => setZoom(null)} disabled={zoom === null} title={t('dataset.edit.zoomFit')} aria-label={t('dataset.edit.zoomFit')}>
          <Icon name="fit" size={14} />
        </button>
      </div>
      <div
        ref={frame}
        className={styles.zoomFrame}
        data-zoomed={zoom !== null || undefined}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        data-testid={testId}
      >
        {src ? (
          <img
            key={src}
            src={src}
            alt=""
            draggable={false}
            decoding="async"
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            style={zoom !== null && natural ? { width: natural.w * zoom, height: natural.h * zoom, maxWidth: 'none', maxHeight: 'none' } : undefined}
          />
        ) : (
          <p className={styles.zoomMissing}>{missing}</p>
        )}
      </div>
    </div>
  )
}
