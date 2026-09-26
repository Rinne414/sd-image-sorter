import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLang, useT } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { useLayer } from '../../ui/layers'
import { useRestart, type RestartScreen } from './restart'
import styles from './RestartOverlay.module.css'
import { busyJobsText } from './restartWait'

/** The question before a restart, and the full screen while the app restarts or updates. */
export function RestartOverlay() {
  const screen = useRestart((s) => s.screen)
  if (screen.kind === 'none') return null
  if (screen.kind === 'ask') return <AskRestart jobs={screen.jobs} />
  return <FullScreen screen={screen} />
}

function AskRestart({ jobs }: { jobs: string[] | null }) {
  const t = useT()
  const lang = useLang((s) => s.lang)
  const answer = useRestart((s) => s.answer)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const busy = jobs !== null
  return (
    <Dialog
      title={t(busy ? 'restart.busy.title' : 'restart.ask.title')}
      onClose={() => answer(false)}
      testId="restart-ask"
      initialFocus={cancelRef}
      footer={
        <>
          <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={() => answer(false)}>
            {t('common.cancel')}
          </button>
          <button type="button" className={busy ? 'btn btn-danger' : 'btn btn-primary'} onClick={() => answer(true)} data-testid="restart-go">
            {t(busy ? 'restart.busy.ok' : 'restart.ask.ok')}
          </button>
        </>
      }
    >
      <p className={styles.askBody}>{busy ? t('restart.busy.body', { jobs: busyJobsText(jobs, t, lang) }) : t('restart.ask.body')}</p>
    </Dialog>
  )
}

type Full = Exclude<RestartScreen, { kind: 'none' } | { kind: 'ask' }>

/** Blocks the page: behind it the old server is gone. Esc does nothing while waiting. */
function FullScreen({ screen }: { screen: Full }) {
  const t = useT()
  const dismiss = useRestart((s) => s.dismiss)
  const waiting = screen.kind === 'wait'
  useLayer(true, () => {
    if (!waiting) dismiss()
  })

  return createPortal(
    <div className={styles.screen} role="alertdialog" aria-modal="true" aria-labelledby="restart-title" aria-busy={waiting} data-testid="restart-screen" data-kind={screen.kind}>
      <div className={styles.panel}>
        {waiting ? <Waiting what={screen.what} latest={screen.latest} /> : <Stopped kind={screen.kind} />}
        {!waiting && (
          <div className={styles.actions}>
            {screen.kind === 'slow' && (
              <button type="button" className="btn btn-primary" onClick={() => window.location.reload()} autoFocus>
                {t('restart.slow.reload')}
              </button>
            )}
            <button type="button" className="btn btn-ghost" onClick={dismiss} autoFocus={screen.kind !== 'slow'}>
              {t('common.close')}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

const WAIT_TITLE = { download: 'restart.wait.download', update: 'restart.wait.update', restart: 'restart.wait.restart' } as const

function Waiting({ what, latest }: { what: 'download' | 'update' | 'restart'; latest: string }) {
  const t = useT()
  const seconds = useSeconds()
  return (
    <>
      <h2 id="restart-title" className={styles.title}>
        {t(WAIT_TITLE[what], { latest })}
      </h2>
      <div className={styles.track} aria-hidden>
        <span className={styles.run} />
      </div>
      <p className={styles.body}>{t(what === 'download' ? 'restart.wait.downloadHint' : 'restart.wait.hint')}</p>
      <p className={`${styles.clock} mono`} data-testid="restart-clock">
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
      </p>
    </>
  )
}

function Stopped({ kind }: { kind: 'slow' | 'unsupported' }) {
  const t = useT()
  return (
    <>
      <h2 id="restart-title" className={styles.title}>
        {t(kind === 'slow' ? 'restart.slow.title' : 'restart.unsupported.title')}
      </h2>
      <p className={styles.body}>{t(kind === 'slow' ? 'restart.slow.body' : 'restart.unsupported.body')}</p>
    </>
  )
}

/** Seconds since this screen appeared. */
function useSeconds(): number {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const start = Date.now()
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return seconds
}
