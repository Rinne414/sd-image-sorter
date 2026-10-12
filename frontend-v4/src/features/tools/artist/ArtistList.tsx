import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemo, useRef } from 'react'
import { useArtistStats } from './artistApi'
import { artistRows, type ArtistRow } from './artistModel'
import styles from './Artist.module.css'
import { artistName, percent } from './artistSummary'
import { useAT } from './artistText'
import { selectArtist, setListTab, useArtistView, type ListTab } from './artistView'

// The confident artists (most images first) and, on their own tab, the
// unconfirmed candidates: kept apart on purpose, since most candidates are
// wrong. The whole list scrolls (no cap); a click opens the artist on the right.

const ROW_H = 46

function Row({ row, rank, top, max, selected }: { row: ArtistRow; rank: number; top: number; max: number; selected: boolean }) {
  const t = useAT()
  const width = max > 0 ? Math.max(4, Math.round((row.count / max) * 100)) : 0
  return (
    <button
      type="button"
      className={styles.artistRow}
      style={{ top, height: ROW_H }}
      aria-pressed={selected}
      onClick={() => selectArtist(row.name)}
      data-testid="artist-row"
      data-artist={row.name}
    >
      <span className={`${styles.rank} mono`}>{rank}</span>
      <span className={styles.nameCell}>
        <span className={styles.name} title={row.name}>
          {artistName(row.name)}
        </span>
        {row.avg !== null && row.peak !== null && (
          <span className={`${styles.conf} mono`}>{t('artist.top.avgPeak', { avg: percent(row.avg), peak: percent(row.peak) })}</span>
        )}
      </span>
      <span className={styles.bar} aria-hidden>
        <span className={styles.barFill} style={{ width: `${width}%` }} />
      </span>
      <span className={`${styles.count} mono`}>{t('artist.top.images', { n: row.count })}</span>
    </button>
  )
}

function Tab({ id, count, current, label }: { id: ListTab; count: number; current: ListTab; label: string }) {
  return (
    <button type="button" role="tab" className={styles.tab} aria-selected={current === id} onClick={() => setListTab(id)} data-testid={`artist-tab-${id}`}>
      {label}
      <span className={`${styles.tabCount} mono`}>{count.toLocaleString()}</span>
    </button>
  )
}

export function ArtistList() {
  const t = useAT()
  const stats = useArtistStats().data
  const tab = useArtistView((s) => s.tab)
  const selected = useArtistView((s) => s.selected)
  const lists = useMemo(() => artistRows(stats), [stats])
  const rows = lists[tab]
  const scroller = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 8 })
  const max = rows[0]?.count ?? 0
  const ran = (stats?.identified_images ?? 0) > 0

  return (
    <section className={styles.listCol} aria-label={t('artist.top.title')} data-testid="artist-list">
      <div className={styles.tabs} role="tablist">
        <Tab id="confident" count={lists.confident.length} current={tab} label={t('artist.top.title')} />
        <Tab id="candidates" count={lists.candidates.length} current={tab} label={t('artist.candidates.title')} />
      </div>
      {tab === 'candidates' && <p className={styles.listHint}>{t('artist.candidates.hint')}</p>}
      <div ref={scroller} className={styles.scroller} data-testid={`artist-list-${tab}`}>
        {rows.length === 0 ? (
          stats && <p className={styles.empty}>{t(tab === 'candidates' ? 'artist.candidates.empty' : ran ? 'artist.top.emptyRan' : 'artist.top.empty')}</p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index] as ArtistRow
              return <Row key={row.name} row={row} rank={v.index + 1} top={v.start} max={max} selected={row.name === selected} />
            })}
          </div>
        )}
      </div>
    </section>
  )
}
