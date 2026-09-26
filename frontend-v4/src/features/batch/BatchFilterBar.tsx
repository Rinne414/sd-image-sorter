import { useT } from '../../i18n'
import { parseSearch } from '../../lib/searchQuery'
import { FilterPanel } from '../library/FilterPanel'
import { visibleMatches } from './batchFilter'
import styles from './BatchFilterBar.module.css'
import { useStepViews, type StepView } from './stepView'

interface Props {
  view: StepView
  total: number
  /** A line under the bar while the name filter hides images (the Order step says how moves work then). */
  hiddenNote?: string
  onSelectMatches: (keys: ReadonlySet<string>) => void
}

/**
 * Narrowing a batch's images: a file-name filter (only the view changes) and
 * a condition in the library's search language, whose matches can be selected.
 */
export function BatchFilterBar({ view, total, hiddenNote, onSelectMatches }: Props) {
  const t = useT()
  const { key, name, condition, matches } = view
  const setName = (text: string) => useStepViews.getState().setName(key, text)
  const setCondition = (text: string) => useStepViews.getState().setCondition(key, text)
  const unread = parseSearch(condition).parts.flatMap((p) => (p.kind === 'warn' ? [p.raw] : []))
  const found = matches.keys
  const filtering = name.trim() !== ''
  const picking = found ? visibleMatches(found, view.shownSet) : null
  const hiddenMatches = found && picking ? found.size - picking.size : 0
  const conditionSet = condition.trim() !== ''

  const status = matches.error
    ? t('batch.filter.failed', { reason: matches.error })
    : matches.searching
      ? t('batch.filter.counting')
      : found
        ? t(hiddenMatches > 0 ? 'batch.filter.matchesHidden' : 'batch.filter.matches', { n: found.size, hidden: hiddenMatches })
        : null

  return (
    <div className={styles.wrap}>
      <div className={styles.bar} data-testid="batch-filter">
        <input
          type="search"
          className={styles.name}
          value={name}
          placeholder={t('batch.filter.name')}
          aria-label={t('batch.filter.name')}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          data-testid="batch-name-filter"
        />
        {filtering && (
          <span className={styles.note} data-testid="batch-name-shown">
            {t('batch.filter.shown', { n: view.shown.length, total })}
          </span>
        )}
        <input
          className={styles.condition}
          value={condition}
          placeholder={t('batch.filter.condition')}
          aria-label={t('batch.filter.conditionLabel')}
          spellCheck={false}
          onChange={(e) => setCondition(e.target.value)}
          data-testid="batch-condition"
        />
        <FilterPanel text={condition} onChange={setCondition} />
        {status && (
          <span className={matches.error ? styles.error : styles.note} role="status" data-testid="batch-condition-count">
            {status}
          </span>
        )}
        <button
          type="button"
          className="btn"
          disabled={!picking || picking.size === 0 || matches.searching}
          onClick={() => picking && onSelectMatches(picking)}
          data-testid="batch-select-matches"
        >
          {picking && !matches.searching ? t('batch.filter.selectMatchesN', { n: picking.size }) : t('batch.filter.selectMatches')}
        </button>
        {(filtering || conditionSet) && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setName('')
              setCondition('')
            }}
            data-testid="batch-filter-clear"
          >
            {t('batch.filter.clear')}
          </button>
        )}
      </div>
      {unread.map((raw) => (
        <p key={raw} className={styles.line} role="alert">
          {t('query.warning', { token: raw })}
        </p>
      ))}
      {conditionSet && matches.outside > 0 && (
        <p className={styles.line} data-testid="batch-condition-outside">
          {t('batch.filter.outside', { n: matches.outside })}
        </p>
      )}
      {filtering && hiddenNote && (
        <p className={styles.line} data-testid="batch-hidden-note">
          {hiddenNote}
        </p>
      )}
    </div>
  )
}
