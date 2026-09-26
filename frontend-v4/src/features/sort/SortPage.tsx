import { useEffect } from 'react'
import { useApp } from '../../state/store'
import { isFinished, isOpen } from './sortSession'
import styles from './SortPage.module.css'
import { SortSetup } from './SortSetup'
import { SortStage } from './SortStage'
import { useSort } from './sortStore'
import { SortSummary } from './SortSummary'

/**
 * The Sort tab: the saved sort when there is one (in progress, or its
 * summary once finished), otherwise the setup of a new one.
 */
export function SortPage() {
  const session = useSort((s) => s.session)
  const setupOpen = useSort((s) => s.setupOpen)
  const libraryId = useApp((s) => s.libraryId)

  useEffect(() => {
    void useSort.getState().load()
  }, [])

  if (session === null) return <section className={styles.page} aria-busy="true" data-testid="sort-loading" />
  if (setupOpen || !isOpen(session) || session.mode !== 'slot') return <SortSetup key={libraryId} />
  return isFinished(session) ? <SortSummary view={session} /> : <SortStage view={session} />
}
