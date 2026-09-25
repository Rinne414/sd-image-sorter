import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { thumbnailUrl } from '../../api/client'
import type { Batch, BatchItem, ImageSummary } from '../../api/types'
import { useT } from '../../i18n'
import { isTypingTarget } from '../../lib/format'
import { useApp } from '../../state/store'
import { Icon } from '../../ui/Icon'
import { layerCount } from '../../ui/layers'
import { Lightbox } from '../lightbox/Lightbox'
import { removeFromBatch } from './batchApi'
import { moveCursor } from './batchLogic'
import { stepLabel } from './labels'
import styles from './PickStep.module.css'

const GAP = 8
const PAD = 16
const CAPTION = 22
const TILE_TARGET = 168

/** Enough of an image summary for the lightbox; the generation card loads the rest. */
function asSummary(item: BatchItem): ImageSummary {
  return {
    id: item.image_id,
    filename: item.filename,
    path: '',
    generator: null,
    width: item.width,
    height: item.height,
    file_size: null,
    checkpoint: null,
    checkpoint_normalized: null,
    loras: null,
    user_rating: null,
    aesthetic_score: null,
    is_readable: null,
    metadata_status: null,
    created_at: null,
    library_order_time: null,
  }
}

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

interface Props {
  batch: Batch
  next: string | null
  onNext: (step: string) => void
}

/** The pick step: the batch's images in order. Arrows move, Enter opens, Delete takes one out. */
export function PickStep({ batch, next, onNext }: Props) {
  const t = useT()
  const items = batch.items
  const scrollRef = useRef<HTMLDivElement>(null)
  const width = useWidth(scrollRef)
  const [cursor, setCursor] = useState(items.length > 0 ? 0 : -1)
  const lightboxId = useApp((s) => s.lightboxId)
  const summaries = useMemo(() => items.map(asSummary), [items])

  const inner = Math.max(0, width - 2 * PAD)
  const cols = Math.max(1, Math.floor((inner + GAP) / (TILE_TARGET + GAP)))
  const tileW = (inner - GAP * (cols - 1)) / cols
  const rows = Math.ceil(items.length / cols)

  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => tileW + CAPTION + GAP,
    overscan: 3,
    paddingStart: PAD,
    paddingEnd: PAD,
  })

  useEffect(() => {
    virtualizer.measure()
  }, [virtualizer, tileW])

  // Keep the cursor on a real item as items come and go; follow the lightbox.
  const at = Math.min(cursor, items.length - 1)
  useEffect(() => {
    if (lightboxId === null) return
    const i = items.findIndex((item) => item.image_id === lightboxId)
    if (i >= 0) setCursor(i)
  }, [lightboxId, items])

  const remove = (index: number) => {
    const item = items[index]
    if (item) void removeFromBatch(batch, [item.image_id])
  }

  const moveTo = (index: number) => {
    setCursor(index)
    if (index >= 0) virtualizer.scrollToIndex(Math.floor(index / cols), { align: 'auto' })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState()
      if (layerCount() > 0 || s.page !== 'batch' || isTypingTarget(e.target) || e.altKey || e.ctrlKey || e.metaKey) return
      // Keys belong to the grid only when nothing else (a button, the rail) has the focus.
      const target = e.target as Node
      if (target !== document.body && !scrollRef.current?.contains(target)) return
      const item = items[at]
      if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') moveTo(moveCursor(at, items.length, cols, e.key))
      else if (e.key === 'Enter' && item) s.openLightbox(item.image_id)
      else if (e.key === 'Delete' && item) remove(at)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const addMore = () => {
    const s = useApp.getState()
    s.setAdding({ batchId: batch.id })
    s.setPage('library')
  }

  return (
    <section className={styles.step} data-testid="pick-step">
      <div className={styles.bar}>
        <strong className={styles.count}>{t('batch.pick.count', { n: items.length })}</strong>
        <span className={styles.hint}>{t('batch.pick.keys')}</span>
        <span className={styles.gap} />
        <button type="button" className={items.length ? 'btn' : 'btn btn-primary'} onClick={addMore} data-testid="add-from-library">
          {t('batch.pick.addMore')}
        </button>
        {next && items.length > 0 && (
          <button type="button" className="btn btn-primary" onClick={() => onNext(next)} data-testid="step-next">
            {t('batch.panel.next', { step: stepLabel(next, t) })}
          </button>
        )}
      </div>
      <div ref={scrollRef} className={styles.scroller} tabIndex={0} role="listbox" aria-label={t('batch.pick.count', { n: items.length })} data-testid="pick-grid">
        {items.length === 0 ? (
          <p className={styles.empty}>{t('batch.pick.empty')}</p>
        ) : (
          <div className={styles.canvas} style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) =>
              items.slice(row.index * cols, row.index * cols + cols).map((item, c) => {
                const index = row.index * cols + c
                return (
                  <div
                    key={item.image_id}
                    className={styles.tile}
                    role="option"
                    aria-selected={index === at}
                    data-cursor={index === at || undefined}
                    data-testid="pick-tile"
                    data-id={item.image_id}
                    title={item.filename}
                    style={{ transform: `translate(${PAD + c * (tileW + GAP)}px, ${row.start}px)`, width: tileW }}
                    onClick={() => setCursor(index)}
                    onDoubleClick={() => useApp.getState().openLightbox(item.image_id)}
                  >
                    <div className={styles.frame} style={{ height: tileW }}>
                      <img src={thumbnailUrl(item.image_id, 256)} alt="" loading="lazy" decoding="async" draggable={false} />
                      <span className={`${styles.order} mono`}>{index + 1}</span>
                      <button
                        type="button"
                        className={styles.remove}
                        tabIndex={-1}
                        aria-label={t('batch.pick.remove', { name: item.filename })}
                        title={t('batch.pick.remove', { name: item.filename })}
                        onClick={(e) => {
                          e.stopPropagation()
                          remove(index)
                        }}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </div>
                    <span className={`${styles.caption} mono`}>{item.filename}</span>
                  </div>
                )
              }),
            )}
          </div>
        )}
      </div>
      <Lightbox images={summaries} total={summaries.length} hasMore={false} fetchMore={noop} pickable={false} />
    </section>
  )
}

function noop(): void {}
