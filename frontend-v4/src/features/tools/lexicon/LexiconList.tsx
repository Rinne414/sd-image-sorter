import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemo, useRef } from 'react'
import type { TagCategory } from '../../../api/types'
import { useT, type MessageKey } from '../../../i18n'
import { useApp } from '../../../state/store'
import { useToasts } from '../../../ui/toasts'
import { recategorize } from './lexiconApi'
import styles from './Lexicon.module.css'
import { activeValues, normalize, toggleEntry, type LexTab } from './lexiconQuery'
import type { LexRow } from './lexiconRows'
import { useLT } from './lexiconText'

// Every row of the tab, virtually scrolled. A click on a name puts it into the
// library search (or takes it out); on the Tags tab the category beside it can
// be changed.

const ROW_H = 34

/** Categories a tag can be moved to (rating keeps its four fixed tags). */
export const TAG_CATEGORIES: readonly TagCategory[] = ['character', 'artist', 'body', 'expression', 'outfit', 'pose', 'angle', 'action', 'background', 'style', 'quality', 'meta', 'unknown']

export function useCategoryName() {
  const t = useT()
  const lt = useLT()
  return (c: string) => (c === 'unknown' ? lt('lex.cat.unknown') : t(`dataset.cat.${c}` as MessageKey))
}

function CategoryCell({ row, category }: { row: LexRow; category: TagCategory | undefined }) {
  const lt = useLT()
  const name = useCategoryName()
  if (!category) return <span />
  if (category === 'rating') return <span className={`${styles.catPlain} cat-rating`}>{name('rating')}</span>
  const change = async (next: TagCategory) => {
    try {
      await recategorize(row.name, next)
      useToasts.getState().push(lt('lex.recat.done', { name: row.name, category: name(next) }))
    } catch (error) {
      useToasts.getState().push(lt('lex.recat.failed', { reason: (error as Error).message }), 'error')
    }
  }
  return (
    <select
      className={`${styles.catSelect} cat-${category}`}
      value={category}
      aria-label={lt('lex.row.category', { name: row.name })}
      onChange={(e) => void change(e.target.value as TagCategory)}
      data-testid="lex-category"
    >
      {TAG_CATEGORIES.map((c) => (
        <option key={c} value={c}>
          {name(c)}
        </option>
      ))}
    </select>
  )
}

interface RowProps {
  row: LexRow
  tab: LexTab
  top: number
  max: number
  on: boolean
  category: TagCategory | undefined
}

function Row({ row, tab, top, max, on, category }: RowProps) {
  const lt = useLT()
  const tags = tab === 'tags'
  const width = max > 0 ? Math.max(2, Math.round((row.count / max) * 100)) : 0
  const toggle = () => {
    const s = useApp.getState()
    s.setQueryText(toggleEntry(s.queryText, tab, row.value))
  }
  return (
    <div className={styles.row} style={{ top, height: ROW_H }} data-plain={tags ? undefined : ''} data-on={on || undefined} data-testid="lex-row" data-name={row.name}>
      <button
        type="button"
        className={`${styles.entry} ${tags && category ? `cat-${category}` : ''}`}
        aria-pressed={on}
        title={`${row.name}\n${lt(on ? 'lex.row.remove' : 'lex.row.add')}`}
        onClick={toggle}
        data-testid="lex-entry"
      >
        <span className={styles.entryName}>{row.name}</span>
      </button>
      {tags && <CategoryCell row={row} category={category} />}
      <span className={styles.bar} aria-hidden>
        <span className={styles.barFill} style={{ width: `${width}%` }} />
      </span>
      <span className={`${styles.count} mono`} data-testid="lex-count">
        {lt('lex.images', { n: row.count })}
      </span>
    </div>
  )
}

interface Props {
  tab: LexTab
  rows: LexRow[]
  categories: ReadonlyMap<string, TagCategory> | undefined
  empty: string
}

export function LexiconList({ tab, rows, categories, empty }: Props) {
  const lt = useLT()
  const queryText = useApp((s) => s.queryText)
  const active = useMemo(() => activeValues(queryText, tab), [queryText, tab])
  const scroller = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 12 })
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0)
  const tags = tab === 'tags'
  return (
    <>
      <div className={styles.head} data-plain={tags ? undefined : ''} aria-hidden>
        <span>{lt('lex.col.name')}</span>
        {tags && <span>{lt('lex.col.category')}</span>}
        <span />
        <span className={styles.headCount}>{lt('lex.col.images')}</span>
      </div>
      <div ref={scroller} className={styles.scroller} data-testid={`lex-list-${tab}`}>
        {rows.length === 0 ? (
          <p className={styles.empty}>{empty}</p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index] as LexRow
              return (
                <Row
                  key={`${row.name}\u0000${row.value}`}
                  row={row}
                  tab={tab}
                  top={v.start}
                  max={max}
                  on={active.has(normalize(row.value))}
                  category={categories?.get(row.name)}
                />
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
