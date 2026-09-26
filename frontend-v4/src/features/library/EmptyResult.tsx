import { useT } from '../../i18n'
import { EMPTY_SCOPE, isBrowsingAll } from '../../lib/browseMemory'
import { useApp } from '../../state/store'
import { useSelectionDialog } from '../selection/dialogs'
import { startColorAnalysis, useColorsMissing } from '../status/colorAnalysis'
import styles from './LibraryPage.module.css'

/** Filters that only see images with colour analysis. */
const COLOR_KEYS = [
  'color_hues',
  'exclude_color_hues',
  'exclude_colors',
  'color_temperature',
  'brightness_distribution',
  'brightness_min',
  'brightness_max',
  'min_saturation',
  'max_saturation',
]

/**
 * An empty grid says which kind of empty it is: a library with no images yet
 * offers the import; a search that found nothing offers to clear it (and, for
 * a colour search, the missing colour analysis).
 */
export function EmptyResult({ params }: { params: Record<string, unknown> }) {
  const t = useT()
  const queryText = useApp((s) => s.queryText)
  const scope = useApp((s) => s.scope)
  const colors = useColorsMissing()

  if (isBrowsingAll({ queryText, scope })) {
    return (
      <div className={styles.notice} data-testid="library-empty">
        <p className={styles.noticeTitle}>{t('browse.empty.title')}</p>
        <p>{t('browse.empty.hint')}</p>
        <button type="button" className="btn btn-primary" onClick={() => useSelectionDialog.getState().showFor('import', null, 1)}>
          {t('browse.empty.import')}
        </button>
      </div>
    )
  }

  const missingColors = COLOR_KEYS.some((k) => k in params) ? (colors.data?.missing ?? 0) : 0
  const clear = () => {
    const s = useApp.getState()
    s.setScope(EMPTY_SCOPE)
    s.setQueryText('')
  }
  return (
    <div className={styles.notice} data-testid="no-matches">
      <p className={styles.noticeTitle}>{t('grid.empty')}</p>
      {missingColors > 0 ? (
        <>
          <p data-testid="color-hint">{t('status.colorHint', { n: missingColors })}</p>
          <div className={styles.noticeActions}>
            <button type="button" className="btn" onClick={() => void startColorAnalysis()}>
              {t('status.colorHintAction')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={clear}>
              {t('browse.noMatch.clear')}
            </button>
          </div>
        </>
      ) : (
        <>
          <p>{t('browse.noMatch.hint')}</p>
          <button type="button" className="btn" onClick={clear} data-testid="clear-filters">
            {t('browse.noMatch.clear')}
          </button>
        </>
      )}
    </div>
  )
}
