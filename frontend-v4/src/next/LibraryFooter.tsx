import { useLibraries } from '../api/queries'
import { useT } from '../i18n'
import { useApp } from '../state/store'
import { displayName } from '../features/library/Rail'
import { useClearRequest } from '../features/settings/library/ClearSection'
import { useStatusDialogs } from '../features/status/dialogs'
import { useStatusRows } from '../features/status/statusRows'
import styles from './LibraryFooter.module.css'

/** Rows on the line itself; the full report lists every one. */
const ROWS_SHOWN = 3

/**
 * The gallery's footer line (docs/DESIGN.md §redesign-2026-10): what the
 * library still needs, each with its fix, and "Clear current library…" at the
 * far end, visible on the gallery page and away from the frequent buttons.
 * Clearing runs the same check and question as Settings › Library.
 */
export function LibraryFooter() {
  const t = useT()
  const rows = useStatusRows()
  const libraries = useLibraries()
  const libraryId = useApp((s) => s.libraryId)
  const current = libraries.data?.libraries.find((l) => l.id === libraryId)
  const name = displayName(current?.name, current?.is_default, t)

  const open = (rows ?? []).filter((r) => r.n > 0)
  const ordered = [...open.filter((r) => !r.quiet), ...open.filter((r) => r.quiet)]
  const shown = ordered.slice(0, ROWS_SHOWN)
  const openReport = () => useStatusDialogs.getState().setReport(true)

  const clear = () => {
    useClearRequest.getState().request()
    useApp.getState().openSettings('library')
  }

  return (
    <footer className={styles.foot} aria-label={t('next.footer.label')} data-testid="next-footer">
      <span className={styles.library}>
        <b>{name}</b>
        {current && <span className={styles.count}>{t('rail.images', { n: current.image_count })}</span>}
      </span>
      <ul className={styles.rows}>
        {rows !== null && shown.length === 0 && <li className={styles.clean}>{t('next.footer.clean')}</li>}
        {shown.map((r) => (
          <li key={r.key} data-quiet={r.quiet || undefined}>
            <span>{t(r.key, { n: r.n })}</span>
            {r.action && (
              <button type="button" className={styles.fix} onClick={r.action.run} disabled={r.action.busy}>
                {r.action.label}
              </button>
            )}
          </li>
        ))}
        <li>
          <button type="button" className={styles.fix} onClick={openReport} data-testid="next-footer-report">
            {t('status.report.open')}
          </button>
        </li>
      </ul>
      <span className={styles.gap} />
      <button
        type="button"
        className={styles.clear}
        onClick={clear}
        title={t('next.footer.clearTitle', { name })}
        data-testid="next-clear-library"
      >
        {t('next.footer.clear')}
      </button>
    </footer>
  )
}
