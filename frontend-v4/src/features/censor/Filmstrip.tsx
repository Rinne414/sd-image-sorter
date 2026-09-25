import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef } from 'react'
import { thumbnailUrl } from '../../api/client'
import type { BatchItem } from '../../api/types'
import { useT, type MessageKey } from '../../i18n'
import styles from './Filmstrip.module.css'
import { pickClick, useCensorPanel } from './panel'
import { initialEdit, itemStatus, keyOf, useCensorSession, type ItemStatus } from './session'

const NONE: number[] = []

const ITEM_H = 116
const PAD = 8

export const STATE_LABEL: Record<ItemStatus, MessageKey> = {
  clean: 'censor.state.clean',
  dirty: 'censor.state.dirty',
  saving: 'censor.state.saving',
  saved: 'censor.state.saved',
  error: 'censor.state.error',
}

interface Props {
  batchId: number
  items: BatchItem[]
  current: number
  onPick: (index: number) => void
}

/** The batch's images down the left, in batch order, each with what happened to its censoring. */
export function Filmstrip({ batchId, items, current, onPick }: Props) {
  const t = useT()
  const edits = useCensorSession((s) => s.edits)
  const picked = useCensorPanel((s) => (s.picked.batchId === batchId ? s.picked.ids : NONE))
  const order = items.map((item) => item.image_id)
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ITEM_H,
    overscan: 4,
    paddingStart: PAD,
    paddingEnd: PAD,
  })

  useEffect(() => {
    if (current >= 0) virtualizer.scrollToIndex(current, { align: 'auto' })
  }, [current, virtualizer])

  const failed = items.filter((item) => itemStatus(item, edits[keyOf(batchId, item.image_id)]) === 'error').length

  return (
    <nav className={styles.strip} aria-label={t('censor.strip')} data-testid="censor-strip">
      <div ref={scrollRef} className={styles.scroller}>
        <div className={styles.list} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const item = items[row.index] as BatchItem
            const edit = edits[keyOf(batchId, item.image_id)]
            const status = itemStatus(item, edit)
            const reviewed = (edit ?? initialEdit(item)).reviewed
            const review = reviewed === null ? null : t(reviewed ? 'censor.state.approved' : 'censor.state.waiting')
            const state = t(STATE_LABEL[status])
            const label = t('censor.strip.item', { i: row.index + 1, name: item.filename, state: review ? `${state} · ${review}` : state })
            return (
              <button
                key={item.image_id}
                type="button"
                className={styles.item}
                style={{ transform: `translateY(${row.start}px)` }}
                aria-current={row.index === current ? 'true' : undefined}
                aria-label={label}
                title={status === 'error' && edit?.error ? `${label} (${edit.error})` : label}
                data-state={status}
                data-review={reviewed === null ? undefined : reviewed ? 'approved' : 'waiting'}
                data-picked={picked.includes(item.image_id) || undefined}
                data-testid="censor-strip-item"
                data-id={item.image_id}
                onClick={(e) => {
                  // Ctrl+click and Shift+click pick images (the Adjust tab applies to them); a plain click opens one.
                  if (e.ctrlKey || e.metaKey) return pickClick(batchId, order, item.image_id, 'toggle')
                  if (e.shiftKey) return pickClick(batchId, order, item.image_id, 'range')
                  pickClick(batchId, order, item.image_id, 'clear')
                  onPick(row.index)
                }}
              >
                <span className={styles.frame}>
                  <img src={thumbnailUrl(item.image_id, 256)} alt="" loading="lazy" decoding="async" draggable={false} />
                  {review && <span className={styles.review}>{review}</span>}
                </span>
                <span className={styles.caption}>
                  <span className="mono">{row.index + 1}</span>
                  <span className={styles.state}>{state}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>
      {failed > 0 && (
        <p className={styles.failed} role="status" data-testid="censor-strip-failed">
          {t('censor.strip.failed', { n: failed })}
        </p>
      )}
    </nav>
  )
}
