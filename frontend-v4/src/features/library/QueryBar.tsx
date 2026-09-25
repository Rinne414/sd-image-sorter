import { useEffect, useRef, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { parseQuery, tokenize, type QueryChip, type SortKey } from '../../lib/query'
import { generatorName } from '../../lib/format'
import { useApp } from '../../state/store'
import { Menu } from '../../ui/Menu'
import styles from './QueryBar.module.css'

const SORTS: SortKey[] = ['newest', 'oldest', 'user_rating', 'aesthetic', 'random', 'name_asc']
const APPLY_DELAY_MS = 300

const CHIP_LABEL: Record<QueryChip['kind'], MessageKey> = {
  text: 'query.chip.text',
  tag: 'query.chip.tag',
  excludeTag: 'query.chip.excludeTag',
  generator: 'query.chip.generator',
  rating: 'query.chip.rating',
  stars: 'query.chip.stars',
}

interface Props {
  total: number | null
  inputRef: React.RefObject<HTMLInputElement | null>
}

export function QueryBar({ total, inputRef }: Props) {
  const t = useT()
  const queryText = useApp((s) => s.queryText)
  const setQueryText = useApp((s) => s.setQueryText)
  const sort = useApp((s) => s.sort)
  const setSort = useApp((s) => s.setSort)
  const layout = useApp((s) => s.layout)
  const setLayout = useApp((s) => s.setLayout)
  const tileSize = useApp((s) => s.tileSize)
  const setTileSize = useApp((s) => s.setTileSize)
  const cardOpen = useApp((s) => s.cardOpen)
  const toggleCard = useApp((s) => s.toggleCard)
  const [draft, setDraft] = useState(queryText)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => setDraft(queryText), [queryText])

  const apply = (text: string, now = false) => {
    window.clearTimeout(timer.current)
    if (now) setQueryText(text)
    else timer.current = window.setTimeout(() => setQueryText(text), APPLY_DELAY_MS)
  }

  const parsed = parseQuery(draft)

  const removeChip = (chip: QueryChip) => {
    const kept = tokenize(draft).filter((tok) => {
      const one = parseQuery(tok).chips[0]
      if (chip.kind === 'text') return one && one.kind !== 'text'
      return !(one && one.kind === chip.kind && one.value === chip.value)
    })
    const next = kept.map((tok) => (/\s/.test(tok) ? `"${tok}"` : tok)).join(' ')
    setDraft(next)
    apply(next, true)
  }

  return (
    <div className={styles.bar}>
      <div className={styles.field}>
        <span className={styles.glyph} aria-hidden>
          ⌕
        </span>
        <input
          ref={inputRef}
          className={styles.input}
          value={draft}
          placeholder={t('query.placeholder')}
          spellCheck={false}
          onChange={(e) => {
            setDraft(e.target.value)
            apply(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply(draft, true)
            if (e.key === 'Escape') {
              if (draft) {
                setDraft('')
                apply('', true)
              } else {
                e.currentTarget.blur()
              }
              e.stopPropagation()
            }
          }}
          aria-label={t('query.placeholder')}
          data-testid="query-input"
        />
        {parsed.chips.length > 0 && (
          <div className={styles.chips}>
            {parsed.chips.map((chip) => (
              <button
                key={`${chip.kind}:${chip.value}`}
                type="button"
                className={styles.chip}
                data-kind={chip.kind}
                onClick={() => removeChip(chip)}
                title={t('query.clear')}
              >
                <span className={styles.chipKey}>{t(CHIP_LABEL[chip.kind], { n: chip.value })}</span>
                {chip.kind !== 'stars' && (
                  <span>{chip.kind === 'generator' ? generatorName(chip.value, t) : chip.value}</span>
                )}
                <span aria-hidden>×</span>
              </button>
            ))}
            {parsed.warnings.map((w) => (
              <span key={w} className={styles.warning}>
                {t('query.warning', { token: w })}
              </span>
            ))}
          </div>
        )}
      </div>

      <Menu
        label={`${t('sort.label')}：${t(`sort.${sort}` as MessageKey)}`}
        items={SORTS.map((s) => ({
          id: s,
          label: t(`sort.${s}` as MessageKey),
          checked: s === sort,
          onSelect: () => setSort(s),
        }))}
      />
      <Menu
        label={t('view.label')}
        align="right"
        items={[
          { id: 'masonry', label: t('view.masonry'), checked: layout === 'masonry', onSelect: () => setLayout('masonry') },
          { id: 'grid', label: t('view.grid'), checked: layout === 'grid', onSelect: () => setLayout('grid') },
          { id: 's', label: t('view.size.s'), checked: tileSize === 's', onSelect: () => setTileSize('s'), divider: true },
          { id: 'm', label: t('view.size.m'), checked: tileSize === 'm', onSelect: () => setTileSize('m') },
          { id: 'l', label: t('view.size.l'), checked: tileSize === 'l', onSelect: () => setTileSize('l') },
          { id: 'card', label: t('view.card'), checked: cardOpen, onSelect: toggleCard, hint: 'I', divider: true },
        ]}
      />
      <span className={`${styles.count} mono`} data-testid="result-count">
        {total === null ? '' : t('grid.count', { n: total })}
      </span>
    </div>
  )
}
