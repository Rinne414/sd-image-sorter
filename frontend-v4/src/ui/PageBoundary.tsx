import { Component, Suspense, type ReactNode } from 'react'
import { useT } from '../i18n'
import styles from './PageBoundary.module.css'

// Around a page that loads its code on demand (a settings tab, a tool): if
// that code cannot be loaded (the app was updated or rebuilt while this tab
// stayed open) or the page fails, say so in place with a way out, instead of
// the whole app going blank.

interface State {
  failed: boolean
}

class Boundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  render() {
    return this.state.failed ? <Failed /> : this.props.children
  }
}

function Failed() {
  const t = useT()
  return (
    <div className={styles.failed} role="alert" data-testid="page-failed">
      <p>{t('page.failed')}</p>
      <button type="button" className="btn" onClick={() => location.reload()}>
        {t('page.reload')}
      </button>
    </div>
  )
}

/** A page loaded on demand: nothing while it loads, a message with "reload" if it cannot. */
export function PageBoundary({ children }: { children: ReactNode }) {
  return (
    <Boundary>
      <Suspense fallback={null}>{children}</Suspense>
    </Boundary>
  )
}
