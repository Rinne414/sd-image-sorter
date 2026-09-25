import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef } from 'react'
import { useT, type MessageKey } from '../../../i18n'
import { entryThumb, type Entry } from '../entries'
import styles from './EditStep.module.css'
import { LIST_FILTERS, type ItemMarks, type ListFilter } from './marks'

const ROW_H = 54

const FILTER_LABEL: Record<ListFilter, MessageKey> = {
  all: 'dataset.edit.filterAll',
  edited: 'dataset.edit.filterEdited',
  ai: 'dataset.edit.filterAi',
  empty: 'dataset.edit.filterEmpty',
}

interface Props {
  shown: readonly Entry[]
  marks: ReadonlyMap<string, ItemMarks>
  counts: Record<ListFilter, number>
  filter: ListFilter
  onFilter: (filter: ListFilter) => void
  current: string | null
  onPick: (key: string) => void
  /** The batch has no trigger word: say it once here, not on every image. */
  noTrigger: boolean
  onSettings: () => void
}

function Marks({ marks }: { marks: ItemMarks | undefined }) {
  const t = useT()
  if (!marks) return null
  return (
    <span className={styles.marks}>
      {marks.edited && <span data-mark="edited">{t('dataset.edit.markEdited')}</span>}
      {marks.ai && <span data-mark="ai">{t('dataset.edit.markAi')}</span>}
      {marks.empty === true && <span data-mark="empty">{t('dataset.edit.markEmpty')}</span>}
      {marks.locked && <span data-mark="locked">{t('dataset.edit.markLocked')}</span>}
    </span>
  )
}

/** The batch's images down the left, marked; the filters on top pick which ones A/D walk through. */
export function ItemList({ shown, marks, counts, filter, onFilter, current, onPick, noTrigger, onSettings }: Props) {
  const t = useT()
  const scroller = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({ count: shown.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 8 })
  const at = shown.findIndex((e) => e.key === current)

  // The current image stays in view as A/D move through the list.
  useEffect(() => {
    if (at >= 0) virtualizer.scrollToIndex(at, { align: 'auto' })
  }, [at, virtualizer])

  return (
    <aside className={styles.list} aria-label={t('dataset.edit.listTitle')} data-testid="edit-list">
      <div className={styles.filters} role="group" aria-label={t('dataset.edit.filterLabel')}>
        {LIST_FILTERS.map((f) => (
          <button key={f} type="button" className={styles.filter} aria-pressed={filter === f} onClick={() => onFilter(f)} data-testid={`edit-filter-${f}`}>
            {t(FILTER_LABEL[f])} <span className="mono">{counts[f]}</span>
          </button>
        ))}
      </div>
      {noTrigger && (
        <p className={styles.listNote} data-testid="edit-no-trigger">
          {t('dataset.edit.noTrigger')}{' '}
          <button type="button" className={styles.linkButton} onClick={onSettings}>
            {t('dataset.settings.open')}
          </button>
        </p>
      )}
      <div ref={scroller} className={styles.listScroll}>
        {shown.length === 0 ? (
          <p className={styles.listNote}>{t('dataset.edit.filterNone')}</p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((row) => {
              const entry = shown[row.index] as Entry
              const thumb = entryThumb(entry, 128)
              return (
                <button
                  key={entry.key}
                  type="button"
                  className={styles.row}
                  style={{ transform: `translateY(${row.start}px)`, height: ROW_H }}
                  aria-current={entry.key === current || undefined}
                  onClick={() => onPick(entry.key)}
                  data-testid="edit-item"
                  data-key={entry.key}
                >
                  <span className={styles.rowThumb}>{thumb && <img src={thumb} alt="" loading="lazy" decoding="async" draggable={false} />}</span>
                  <span className={styles.rowText}>
                    <span className={`${styles.rowName} mono`} title={entry.filename}>
                      {entry.filename}
                    </span>
                    <Marks marks={marks.get(entry.key)} />
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </aside>
  )
}
