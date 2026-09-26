import { IntakeButtonsMany } from '../intake/Intake'
import { isHuge } from './engine/imageSize'
import styles from './Privacy.module.css'
import { usePT } from './privacyText'
import { clearQueue, usePrivacy } from './privacyStore'
import { addFiles } from './queueIntake'
import { runAll, stopRun, summaryText } from './runQueue'
import { downloadAll } from './share'

// Above the queue: its size and more images on the left; the run and the ZIP
// on the right; below them the run's progress (with Cancel) or how it ended.

function RunLine() {
  const t = usePT()
  const run = usePrivacy((s) => s.run)
  const summary = usePrivacy((s) => s.summary)
  const huge = usePrivacy((s) => s.items.filter((it) => isHuge(it.size)).length)
  const handled = run ? run.done + run.failed : 0

  return (
    <div className={styles.runLine}>
      {run ? (
        <>
          <span className={styles.runText} role="status" data-testid="privacy-progress">
            {run.stopping ? t('privacy.stopping') : t(run.direction === 'encode' ? 'privacy.running.encode' : 'privacy.running.decode', { done: handled, total: run.total })}
          </span>
          <span className={styles.progress} aria-hidden>
            <span style={{ width: `${run.total ? (handled / run.total) * 100 : 0}%` }} />
          </span>
          <button type="button" className="btn" onClick={stopRun} disabled={run.stopping} data-testid="privacy-stop">
            {t('privacy.stop')}
          </button>
        </>
      ) : (
        summary && (
          <span className={summary.failed ? styles.runProblem : styles.runText} role="status" data-testid="privacy-summary">
            {summaryText(summary)}
          </span>
        )
      )}
      {huge > 0 && (
        <span className={styles.warnText} data-testid="privacy-huge-count">
          {t('privacy.hugeCount', { n: huge })}
        </span>
      )}
    </div>
  )
}

export function QueueBar() {
  const t = usePT()
  const count = usePrivacy((s) => s.items.length)
  const running = usePrivacy((s) => s.run !== null)
  const zipping = usePrivacy((s) => s.zipping)
  const hasResults = usePrivacy((s) => s.items.some((it) => it.result))

  return (
    <header className={styles.bar}>
      <div className={styles.barRow}>
        <div className={styles.barGroup}>
          <h2 className={styles.heading}>
            {t('privacy.queue')} <span className={styles.count} data-testid="privacy-count">{t('privacy.count', { n: count })}</span>
          </h2>
          <IntakeButtonsMany onFiles={addFiles} pickLabel={t('privacy.pick')} />
          <button type="button" className="btn btn-ghost" onClick={clearQueue} disabled={running} data-testid="privacy-clear">
            {t('privacy.clear')}
          </button>
        </div>
        <div className={styles.barGroup}>
          <button type="button" className="btn" onClick={() => void downloadAll()} disabled={!hasResults || zipping} title={t('privacy.downloadAll.hint')} data-testid="privacy-download-all">
            {zipping ? t('privacy.zipping') : t('privacy.downloadAll')}
          </button>
          <button type="button" className="btn" onClick={() => void runAll('decode')} disabled={running} title={t('privacy.restoreAll.hint')} data-testid="privacy-restore-all">
            {t('privacy.restoreAll')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void runAll('encode')} disabled={running} title={t('privacy.protectAll.hint')} data-testid="privacy-protect-all">
            {t('privacy.protectAll')}
          </button>
        </div>
      </div>
      <RunLine />
    </header>
  )
}
