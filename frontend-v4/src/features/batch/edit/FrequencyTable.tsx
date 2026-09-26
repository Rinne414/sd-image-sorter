import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemo, useRef, useState } from 'react'
import type { TagCategory } from '../../../api/types'
import { useT, type MessageKey } from '../../../i18n'
import { tagKey as promptKey } from '../../../lib/prompt'
import styles from './Bulk.module.css'
import type { TagRow } from './captionOps'
import type { TraitMark } from './tagInsights'
import { displayTag } from './tagStyle'

const ROW_H = 38

export interface RowActions {
  remove: (row: TagRow) => void
  blacklist: (row: TagRow, add: boolean) => void
  common: (row: TagRow, add: boolean) => void
  locate: (row: TagRow) => void
  findMissed: (row: TagRow) => void
}

interface Props {
  rows: readonly TagRow[]
  scopeSize: number
  categories: ReadonlyMap<string, TagCategory> | undefined
  blacklisted: ReadonlySet<string>
  /** The batch's common tags (tag keys). */
  common: ReadonlySet<string>
  traits: ReadonlyMap<string, TraitMark> | null
  busy: boolean
  actions: RowActions
  /** The tag's Library tag scores can say where it was missed (Library images only). */
  canFindMissed: boolean
  children?: React.ReactNode
}

/** Every tag the captions in scope use, how many have it, and what can be done with it. */
export function FrequencyTable({ rows, scopeSize, categories, blacklisted, common, traits, busy, actions, canFindMissed, children }: Props) {
  const t = useT()
  const [filter, setFilter] = useState('')
  const [onlyTraits, setOnlyTraits] = useState(false)
  const shown = useMemo(() => {
    const needle = filter.trim().replace(/_/g, ' ').toLowerCase()
    return rows.filter((row) => (!needle || row.key.includes(needle)) && (!onlyTraits || traits?.has(row.key)))
  }, [rows, filter, onlyTraits, traits])
  const scroller = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({ count: shown.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 10 })

  return (
    <section className={styles.table} aria-label={t('dataset.freq.title')} data-testid="freq-table">
      <header className={styles.tableHead}>
        <span className={styles.label}>{t('dataset.freq.title')}</span>
        <span className={styles.headCount}>{t('dataset.freq.count', { n: rows.length })}</span>
        <span className={styles.gap} />
        <input
          className={styles.filterInput}
          value={filter}
          placeholder={t('dataset.freq.filter')}
          aria-label={t('dataset.freq.filter')}
          onChange={(e) => setFilter(e.target.value)}
          data-testid="freq-filter"
        />
        {traits && (
          <label className={styles.check}>
            <input type="checkbox" checked={onlyTraits} onChange={(e) => setOnlyTraits(e.target.checked)} />
            {t('dataset.freq.onlyTraits')}
          </label>
        )}
      </header>
      {children}
      <div ref={scroller} className={styles.tableScroll}>
        {shown.length === 0 ? (
          <p className={styles.empty}>{rows.length === 0 ? t('dataset.freq.none') : t('dataset.freq.noMatch')}</p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = shown[v.index] as TagRow
              return (
                <Row
                  key={row.key}
                  row={row}
                  top={v.start}
                  scopeSize={scopeSize}
                  category={categories?.get(promptKey(row.tag)) ?? 'unknown'}
                  listed={blacklisted.has(row.key)}
                  inCommon={common.has(row.key)}
                  trait={traits?.get(row.key)}
                  busy={busy}
                  actions={actions}
                  canFindMissed={canFindMissed}
                />
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

interface RowProps {
  row: TagRow
  top: number
  scopeSize: number
  category: string
  listed: boolean
  inCommon: boolean
  trait: TraitMark | undefined
  busy: boolean
  actions: RowActions
  canFindMissed: boolean
}

function Row({ row, top, scopeSize, category, listed, inCommon, trait, busy, actions, canFindMissed }: RowProps) {
  const t = useT()
  const share = scopeSize > 0 ? row.count / scopeSize : 0
  return (
    <div className={styles.row} style={{ transform: `translateY(${top}px)`, height: ROW_H }} data-testid="freq-row" data-tag={row.tag}>
      <span className={`chip cat-${category} ${styles.rowChip}`} data-listed={listed || undefined} title={listed ? t('dataset.edit.droppedBlacklist') : undefined}>
        {displayTag(row.tag)}
      </span>
      <span className={styles.traitCell}>
        {trait && (
          <span className={styles.trait} title={t('dataset.freq.traitHint')} data-testid="freq-trait">
            {t('dataset.freq.trait', { family: t(`dataset.family.${trait.family}` as MessageKey), pct: Math.round(trait.ratio * 100) })}
          </span>
        )}
      </span>
      <span className={styles.bar} aria-hidden>
        <span style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
      <span className={`${styles.rowCount} mono`}>{t('dataset.freq.images', { n: row.count })}</span>
      <span className={styles.rowActions}>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => actions.remove(row)} data-testid="freq-remove">
          {t('dataset.freq.remove')}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => actions.blacklist(row, !listed)} data-testid="freq-blacklist">
          {listed ? t('dataset.freq.unlist') : t('dataset.freq.blacklist')}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          aria-pressed={inCommon}
          title={inCommon ? t('dataset.freq.uncommonHint') : t('dataset.freq.commonHint')}
          onClick={() => actions.common(row, !inCommon)}
          data-testid="freq-common"
        >
          {inCommon ? t('dataset.freq.uncommon') : t('dataset.freq.common')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => actions.locate(row)} data-testid="freq-locate">
          {t('dataset.freq.locate')}
        </button>
        {canFindMissed && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => actions.findMissed(row)} data-testid="freq-missed">
            {t('dataset.freq.findMissed')}
          </button>
        )}
      </span>
    </div>
  )
}
