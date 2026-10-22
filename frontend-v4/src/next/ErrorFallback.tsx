import { Component, useEffect, type ReactNode } from 'react'
import { translate, useLang, useT } from '../i18n'
import { copyText } from '../lib/format'
import { useApp } from '../state/store'
import { useToasts } from '../ui/toasts'
import styles from './ErrorFallback.module.css'
import { hidePaths } from './errorText'

// Never a white screen (owner baseline, docs/DESIGN.md §redesign-2026-10): a
// render error shows what failed and the ways on, in place of the screen that
// failed; an error outside rendering (a rejected promise, a script error) is
// said in a toast and the screen stays.

function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

interface BoundaryProps {
  children: ReactNode
  /** Where "back to the library" leads; omitted on the outermost boundary. */
  home?: boolean
}

interface BoundaryState {
  error: unknown
}

export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error ?? new Error('unknown') }
  }

  render() {
    if (this.state.error === null) return this.props.children
    return <Failed error={this.state.error} home={this.props.home ?? false} reset={() => this.setState({ error: null })} />
  }
}

function Failed({ error, home, reset }: { error: unknown; home: boolean; reset: () => void }) {
  const t = useT()
  const reason = hidePaths(reasonOf(error))
  const copy = () => {
    const stack = error instanceof Error && error.stack ? `\n${error.stack}` : ''
    void copyText(hidePaths(`${reasonOf(error)}${stack}\n${navigator.userAgent}\n${location.pathname}${location.hash}`)).then(() =>
      useToasts.getState().push(t('next.error.copied')),
    )
  }
  return (
    <div className={styles.failed} role="alert" data-testid="next-error">
      <h2 className={styles.title}>{t('next.error.title')}</h2>
      <p className={styles.lead}>{t('next.error.lead')}</p>
      <p className={styles.reason}>{t('next.error.reason', { reason })}</p>
      <div className={styles.actions}>
        <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
          {t('next.error.reload')}
        </button>
        {home && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              useApp.getState().setPage('library')
              reset()
            }}
          >
            {t('next.error.home')}
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={copy}>
          {t('next.error.copy')}
        </button>
      </div>
    </div>
  )
}

/** Window-level errors that no screen caught: said once in a while, never silently dropped. */
export function useBackgroundErrors(): void {
  useEffect(() => {
    let lastAt = 0
    const say = (error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return
      const now = Date.now()
      if (now - lastAt < 4000) return
      lastAt = now
      const text = translate(useLang.getState().lang, 'next.error.background', { reason: hidePaths(reasonOf(error)) })
      useToasts.getState().push(text, 'error')
    }
    const onError = (e: ErrorEvent) => say(e.error ?? e.message)
    const onRejection = (e: PromiseRejectionEvent) => say(e.reason)
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])
}
