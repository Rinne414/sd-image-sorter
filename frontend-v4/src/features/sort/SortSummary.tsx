import { useContext, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { useApp } from '../../state/store'
import { openFolderPath } from '../library/fileActions'
import { useTargetName } from './keyTargets'
import { FolderLabel } from './SetupParts'
import { useSortPrefs } from './sortPrefs'
import { slotTarget, summary, type SessionView } from './sortSession'
import styles from './SortPage.module.css'
import { useSort } from './sortStore'
import { errorText, FocusTop, OtherLibraryBanner } from './StageParts'
import { releaseButtonFocus, useSortKeys } from './useSortKeys'

interface FrameProps {
  view: SessionView
  title: string
  body: string
  children: ReactNode
}

/** The page every finished sort shows: what happened, then undo, sort again, or back to the library. */
export function SummaryFrame({ view, title, body, children }: FrameProps) {
  const t = useT()
  const busy = useSort((s) => s.sending)
  const error = useSort((s) => s.error)
  const cooldownMs = useSortPrefs((s) => s.cooldownMs)
  useSortKeys(view.mode, useContext(FocusTop))

  const leave = async (to: 'library' | 'setup') => {
    const ok = await useSort.getState().end()
    if (ok && to === 'library') useApp.getState().setPage('library')
  }

  return (
    <section className={styles.page} data-testid="sort-summary" data-mode={view.mode} onClick={releaseButtonFocus}>
      <div className={styles.sheet}>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.lede} data-testid="sort-summary-body">
          {body}
        </p>
        <OtherLibraryBanner view={view} />
        {children}
        {error && (
          <p className={styles.error} role="alert" data-testid="sort-summary-error">
            {errorText(t, error, cooldownMs)}
          </p>
        )}
        <div className={styles.doneActions}>
          <button type="button" className="btn" onClick={() => useSort.getState().press({ kind: 'undo' })} disabled={!view.canUndo || busy} data-testid="sort-done-undo">
            {t('sort.done.undo')}
            <kbd>Backspace</kbd>
          </button>
          <span className={styles.gap} />
          <button type="button" className="btn" onClick={() => void leave('setup')} data-testid="sort-again">
            {t('sort.done.again')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void leave('library')} data-testid="sort-back">
            {t('sort.done.back')}
          </button>
        </div>
      </div>
    </section>
  )
}

/** Every image has been judged: which folder got how many. Backspace still undoes the last one. */
export function SortSummary({ view }: { view: SessionView }) {
  const t = useT()
  const namer = useTargetName()
  const { rows, sent } = summary(view)
  const body = t(view.operation === 'copy' ? 'sort.done.bodyCopy' : 'sort.done.body', { total: view.total, sent, skipped: view.skipped })
  return (
    <SummaryFrame view={view} title={t('sort.done.title')} body={body}>
      <ul className={styles.doneList}>
        {rows.map(({ slot, folder, collection, count }) => (
          <li key={slot} className={styles.doneRow} data-slot={slot} data-count={count}>
            <kbd className={styles.cap}>{slot.toUpperCase()}</kbd>
            {folder ? (
              <FolderLabel path={folder} />
            ) : (
              <span className={styles.unset}>
                {slotTarget(view, slot, namer.favoritesId)?.kind === 'favorites' ? t('rail.favorites') : t('sort.slot.collection', { id: collection ?? 0 })}
              </span>
            )}
            <span className={`${styles.doneCount} mono`}>{t('sort.count', { n: count })}</span>
            {folder ? (
              <button type="button" className="btn" onClick={() => void openFolderPath(folder)} disabled={count === 0}>
                {t('sort.done.open')}
              </button>
            ) : (
              <span />
            )}
          </li>
        ))}
        <li className={styles.doneRow}>
          <kbd className={styles.cap}>{t('sort.spaceKey')}</kbd>
          <span className={styles.unset}>{t('sort.done.skipped')}</span>
          <span className={`${styles.doneCount} mono`}>{t('sort.count', { n: view.skipped })}</span>
          <span />
        </li>
      </ul>
    </SummaryFrame>
  )
}
