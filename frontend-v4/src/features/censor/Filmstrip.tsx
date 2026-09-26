import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef } from 'react'
import { thumbnailUrl } from '../../api/client'
import type { BatchItem } from '../../api/types'
import { useT, type MessageKey } from '../../i18n'
import { byName } from '../batch/batchFilter'
import { useStepViews, useViewKey } from '../batch/stepView'
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

/**
 * The batch's images down the left, in batch order, each with what happened
 * to its censoring. The name filter (shared with Pick and Order) only narrows
 * the strip; the editor still steps through every image.
 */
export function Filmstrip({ batchId, items, current, onPick }: Props) {
  const t = useT()
  const edits = useCensorSession((s) => s.edits)
  const picked = useCensorPanel((s) => (s.picked.batchId === batchId ? s.picked.ids : NONE))
  const viewKey = useViewKey(batchId)
  const name = useStepViews((s) => s.names[viewKey] ?? '')
  const rows = useMemo(() => byName(items.map((item, index) => ({ item, index, key: String(item.image_id), filename: item.filename })), name), [items, name])
  const order = rows.map((row) => row.item.image_id)
  const at = rows.findIndex((row) => row.index === current)
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ITEM_H,
    overscan: 4,
    paddingStart: PAD,
    paddingEnd: PAD,
  })

  useEffect(() => {
    if (at >= 0) virtualizer.scrollToIndex(at, { align: 'auto' })
  }, [at, virtualizer])

  const failed = items.filter((item) => itemStatus(item, edits[keyOf(batchId, item.image_id)]) === 'error').length

  return (
    <nav className={styles.strip} aria-label={t('censor.strip')} data-testid="censor-strip">
      <input
        type="search"
        className={styles.filter}
        value={name}
        placeholder={t('batch.filter.nameShort')}
        aria-label={t('batch.filter.name')}
        spellCheck={false}
        onChange={(e) => useStepViews.getState().setName(viewKey, e.target.value)}
        data-testid="censor-strip-filter"
      />
      <div ref={scrollRef} className={styles.scroller}>
        {rows.length === 0 && items.length > 0 && <p className={styles.none}>{t('batch.filter.noneShown', { text: name.trim() })}</p>}
        <div className={styles.list} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const { item, index } = rows[row.index] as { item: BatchItem; index: number }
            const edit = edits[keyOf(batchId, item.image_id)]
            const status = itemStatus(item, edit)
            const reviewed = (edit ?? initialEdit(item)).reviewed
            const review = reviewed === null ? null : t(reviewed ? 'censor.state.approved' : 'censor.state.waiting')
            const state = t(STATE_LABEL[status])
            const label = t('censor.strip.item', { i: index + 1, name: item.filename, state: review ? `${state} · ${review}` : state })
            return (
              <button
                key={item.image_id}
                type="button"
                className={styles.item}
                style={{ transform: `translateY(${row.start}px)` }}
                aria-current={index === current ? 'true' : undefined}
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
                  onPick(index)
                }}
              >
                <span className={styles.frame}>
                  <img src={thumbnailUrl(item.image_id, 256)} alt="" loading="lazy" decoding="async" draggable={false} />
                  {review && <span className={styles.review}>{review}</span>}
                </span>
                <span className={styles.caption}>
                  <span className="mono">{index + 1}</span>
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
