import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import type { Batch } from '../../api/types'
import { useT } from '../../i18n'
import { isTypingTarget } from '../../lib/format'
import { useApp } from '../../state/store'
import { layerCount } from '../../ui/layers'
import { reorderBatch } from './batchApi'
import { moveCursor } from './batchLogic'
import { ItemBadges, ItemImage } from './ItemImage'
import { stepLabel } from './labels'
import { dropIndex, moveTo, reorderTarget } from './orderLogic'
import styles from './OrderStep.module.css'
import { StepBar } from './StepBar'

interface Drag {
  from: number
  over: number
  after: boolean
}

/** Columns the grid currently lays out (for ↑/↓). */
function useColumns(ref: React.RefObject<HTMLElement | null>): number {
  const [cols, setCols] = useState(1)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setCols(Math.max(1, getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length))
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return cols
}

interface Props {
  batch: Batch
  next: string | null
  onNext: (step: string) => void
}

/** The posting order: large pictures as they will be posted; drag, or Alt + arrows / Home / End. */
export function OrderStep({ batch, next, onNext }: Props) {
  const t = useT()
  const items = batch.items
  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const cols = useColumns(gridRef)
  const [cursor, setCursor] = useState(items.length > 0 ? 0 : -1)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [said, setSaid] = useState('')
  const at = Math.min(cursor, items.length - 1)

  const move = (from: number, to: number) => {
    const ids = items.map((item) => item.image_id)
    const reordered = moveTo(ids, from, to)
    if (reordered === ids) return
    const place = reordered.indexOf(ids[from] as number)
    void reorderBatch(batch.id, reordered)
    setCursor(place)
    setSaid(t('batch.order.moved', { name: items[from]?.filename ?? '', n: place + 1 }))
  }

  useEffect(() => {
    gridRef.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [at])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState()
      if (layerCount() > 0 || s.page !== 'batch' || isTypingTarget(e.target) || e.ctrlKey || e.metaKey) return
      const target = e.target as Node
      if (target !== document.body && !scrollRef.current?.contains(target)) return
      if (e.altKey) {
        const to = reorderTarget(e.key, at, items.length)
        if (to === null) return
        move(at, to)
      } else if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') {
        setCursor(moveCursor(at, items.length, cols, e.key))
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const over = (e: DragEvent<HTMLDivElement>, index: number) => {
    if (!drag) return
    e.preventDefault()
    const box = e.currentTarget.getBoundingClientRect()
    const after = e.clientX > box.left + box.width / 2
    if (drag.over !== index || drag.after !== after) setDrag({ ...drag, over: index, after })
  }

  const drop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (drag) move(drag.from, dropIndex(drag.from, drag.over, drag.after))
    setDrag(null)
  }

  return (
    <section className={styles.step} data-testid="order-step">
      <StepBar count={t('batch.pick.count', { n: items.length })} hint={t('batch.order.keys')}>
        {next && (
          <button type="button" className="btn btn-primary" onClick={() => onNext(next)} data-testid="step-next">
            {t('batch.panel.next', { step: stepLabel(next, t) })}
          </button>
        )}
      </StepBar>
      <div ref={scrollRef} className={styles.scroller} tabIndex={0} role="listbox" aria-label={t('batch.order.label')} data-testid="order-grid">
        {items.length === 0 ? (
          <p className={styles.empty}>{t('batch.order.empty')}</p>
        ) : (
          <div ref={gridRef} className={styles.grid}>
            {items.map((item, index) => (
              <div
                key={item.image_id}
                className={styles.tile}
                role="option"
                aria-selected={index === at}
                data-index={index}
                data-cursor={index === at || undefined}
                data-dragging={drag?.from === index || undefined}
                data-drop={drag && drag.over === index && drag.from !== index ? (drag.after ? 'after' : 'before') : undefined}
                data-testid="order-tile"
                data-id={item.image_id}
                title={item.filename}
                draggable
                onClick={() => setCursor(index)}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', String(item.image_id))
                  setCursor(index)
                  setDrag({ from: index, over: index, after: false })
                }}
                onDragOver={(e) => over(e, index)}
                onDrop={drop}
                onDragEnd={() => setDrag(null)}
              >
                <div className={styles.frame}>
                  <ItemImage batch={batch} item={item} size={512} />
                  <span className={`${styles.number} mono`} data-testid="order-number">
                    {index + 1}
                  </span>
                </div>
                <div className={styles.meta}>
                  <span className={`${styles.caption} mono`}>{item.filename}</span>
                  <ItemBadges item={item} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="visually-hidden" aria-live="polite">
        {said}
      </p>
    </section>
  )
}
