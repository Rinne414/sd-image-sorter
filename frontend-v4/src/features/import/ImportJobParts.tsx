import { useState } from 'react'
import { useLibraryHealth } from '../../api/queries'
import { useT } from '../../i18n'
import type { Job } from '../jobs/jobs'
import { isFinished } from '../jobs/progress'
import { useSelectionDialog } from '../selection/dialogs'
import { claimIntoLibrary, showImported } from './afterImport'
import styles from './ImportJobParts.module.css'
import { copyDiagnostics, copyLogPath, openLog } from './supportLog'

// An import's rows in the Jobs drawer beyond its progress: a card when it has
// shown no progress for a while, and the next steps once it has finished.

/** While an import shows no progress: what it is doing, and how to get help. */
export function ScanStallCard({ job }: { job: Job }) {
  const t = useT()
  const stall = job.progress.scan?.stall
  if (job.kind !== 'scan' || !stall || isFinished(job.progress.status)) return null
  return (
    <div className={styles.card} data-testid="scan-stall">
      <p className={styles.title}>{t('import.diag.title')}</p>
      <p className={styles.body}>{t('import.diag.body', { seconds: stall.seconds })}</p>
      <dl className={styles.facts}>
        <dt>{t('import.diag.step')}</dt>
        <dd className="mono">{stall.step || '—'}</dd>
        <dt>{t('import.diag.item')}</dt>
        <dd className="mono" title={stall.item ?? undefined}>
          {stall.item ?? '—'}
        </dd>
        <dt>{t('import.diag.pending')}</dt>
        <dd className="mono">{stall.pending.toLocaleString()}</dd>
        <dt>{t('import.diag.done')}</dt>
        <dd className="mono">{`${stall.done.toLocaleString()} / ${stall.total ? stall.total.toLocaleString() : '?'}`}</dd>
      </dl>
      <div className={styles.actions}>
        <button type="button" className="btn" onClick={() => void copyDiagnostics()}>
          {t('import.diag.copy')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void openLog()}>
          {t('import.diag.openLog')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void copyLogPath()}>
          {t('import.diag.copyLogPath')}
        </button>
      </div>
    </div>
  )
}

/** After an import of ours: look at just it, tag what is untagged, take in what another library held. */
export function ImportNextSteps({ job, onLeave }: { job: Job; onLeave: () => void }) {
  const t = useT()
  const health = useLibraryHealth()
  const [claimed, setClaimed] = useState(false)
  const p = job.progress
  if (job.kind !== 'scan' || p.status !== 'done' || job.adopted) return null
  const untagged = health.data?.issue_counts.untagged ?? 0
  const other = p.scan?.otherLibrary
  const folder = job.destination
  return (
    <div className={styles.next} data-testid="import-next">
      {folder && p.succeeded > 0 && (
        <button
          type="button"
          className="btn"
          onClick={() => {
            onLeave()
            showImported(folder)
          }}
        >
          {t('import.next.show')}
        </button>
      )}
      {untagged > 0 && (
        <button
          type="button"
          className="btn"
          onClick={() => {
            onLeave()
            useSelectionDialog.getState().showFor('tag', null, untagged)
          }}
        >
          {t('import.next.tag', { n: untagged })}
        </button>
      )}
      {other && other.paths.length > 0 && !claimed && (
        <button type="button" className="btn" onClick={() => void claimIntoLibrary(other.paths).then((ok) => setClaimed(ok))}>
          {t('import.next.claim', { n: other.paths.length })}
        </button>
      )}
    </div>
  )
}
