import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../../state/store'
import { useLayer } from '../../ui/layers'
import { CullStage } from './CullStage'
import { DuelStage } from './DuelStage'
import { CullSummary, DuelSummary } from './ModeSummaries'
import { useSortPrefs } from './sortPrefs'
import { isFinished, isOpen, type SessionView } from './sortSession'
import styles from './SortPage.module.css'
import { SortSetup } from './SortSetup'
import { SortStage } from './SortStage'
import { useSort } from './sortStore'
import { SortSummary } from './SortSummary'
import { FocusTop } from './StageParts'

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
  if (setupOpen || !isOpen(session)) return <SortSetup key={libraryId} />
  return <FocusFrame>{sessionView(session)}</FocusFrame>
}

function sessionView(view: SessionView): ReactNode {
  if (isFinished(view)) {
    if (view.mode === 'bracket') return <DuelSummary view={view} />
    return view.mode === 'cull' ? <CullSummary view={view} /> : <SortSummary view={view} />
  }
  if (view.mode === 'bracket') return <DuelStage view={view} />
  return view.mode === 'cull' ? <CullStage view={view} /> : <SortStage view={view} />
}

/**
 * Focus mode: the sort takes the whole window, over the top bar. It is a
 * layer, so Esc leaves it (and only it); dialogs still open above it.
 */
function FocusFrame({ children }: { children: ReactNode }) {
  const focus = useSortPrefs((s) => s.focus)
  const isTop = useLayer(focus, () => useSortPrefs.getState().setFocus(false))
  if (!focus) return <FocusTop.Provider value={null}>{children}</FocusTop.Provider>
  return createPortal(
    <div className={styles.focus} data-testid="sort-focus-frame">
      <FocusTop.Provider value={isTop}>{children}</FocusTop.Provider>
    </div>,
    document.body,
  )
}
