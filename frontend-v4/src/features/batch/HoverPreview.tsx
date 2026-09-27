import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { imageFileUrl } from '../../api/urls'
import { uiZoom } from '../../lib/uiScale'
import type { Batch, BatchItem } from '../../api/types'
import { entryThumb, type Entry } from './entries'
import { useCensoredUrl } from './exportApi'
import { HOVER_DELAY_MS, hoverPlace, pagePlace, previewBox } from './hoverPlace'
import styles from './HoverPreview.module.css'

// The Order step's hover preview: after a short hover a larger picture shows
// beside the pointer (V3.5's queue). It never takes clicks or keys; a press,
// a key, the wheel or leaving the tile puts it away.

export interface Hovered {
  entry: Entry
  x: number
  y: number
}

export function useHoverPreview() {
  const [shown, setShown] = useState<Hovered | null>(null)
  const timer = useRef(0)

  useEffect(() => {
    const hide = () => {
      window.clearTimeout(timer.current)
      setShown(null)
    }
    window.addEventListener('keydown', hide)
    window.addEventListener('wheel', hide, { passive: true })
    window.addEventListener('pointerdown', hide, true)
    return () => {
      window.clearTimeout(timer.current)
      window.removeEventListener('keydown', hide)
      window.removeEventListener('wheel', hide)
      window.removeEventListener('pointerdown', hide, true)
    }
  }, [])

  const enter = (entry: Entry, e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.buttons !== 0) return
    const at = { x: e.clientX, y: e.clientY }
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setShown({ entry, ...at }), HOVER_DELAY_MS)
  }

  const leave = () => {
    window.clearTimeout(timer.current)
    setShown(null)
  }

  return { shown, enter, leave }
}

/** The picture as it will be posted: a censored copy when there is one, never the original in its place. */
export function HoverPreview({ batch, shown }: { batch: Batch; shown: Hovered | null }) {
  if (!shown) return null
  // (the preview's CSS is in page px: the pointer and the window are read the same way)
  const { pointer, viewport } = pagePlace(shown, { w: window.innerWidth, h: window.innerHeight }, uiZoom())
  const { entry } = shown
  const box = previewBox(entry.width, entry.height, viewport)
  const place = hoverPlace(pointer, box, viewport)
  return createPortal(
    <div className={styles.preview} style={{ left: place.left, top: place.top, width: box.w, height: box.h }} aria-hidden data-testid="order-hover-preview" data-id={entry.imageId ?? undefined}>
      {entry.item?.has_censored ? <CensoredPicture batch={batch} item={entry.item} /> : <PlainPicture entry={entry} />}
    </div>,
    document.body,
  )
}

function CensoredPicture({ batch, item }: { batch: Batch; item: BatchItem }) {
  const url = useCensoredUrl(batch, item, true)
  return url ? <img src={url} alt="" draggable={false} data-censored /> : null
}

/** The tile's thumbnail at once, the full picture over it once loaded. */
function PlainPicture({ entry }: { entry: Entry }) {
  const thumb = entryThumb(entry, 512)
  return (
    <>
      {thumb && <img src={thumb} alt="" draggable={false} />}
      {entry.imageId !== null && <img src={imageFileUrl(entry.imageId)} alt="" decoding="async" draggable={false} />}
    </>
  )
}
