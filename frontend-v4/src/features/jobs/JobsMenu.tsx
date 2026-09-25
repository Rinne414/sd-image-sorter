import { useRef } from 'react'
import { findLoadedImage } from '../../api/loaded'
import { useT } from '../../i18n'
import { tailOfPath } from '../../lib/paths'
import { useApp } from '../../state/store'
import { Icon } from '../../ui/Icon'
import { useClickOutside, useLayer } from '../../ui/layers'
import { canStop, jobHeadline, stopJob, undoJob, useJobs, type Job } from './jobs'
import styles from './Jobs.module.css'
import { isFinished } from './progress'
import { useSelectionDialog } from '../selection/dialogs'
import { openFolderPath } from '../library/fileActions'

/** Failures listed per job; the rest are counted. */
const MAX_LISTED = 20

/** Top-bar button (only while there are jobs) and the drawer it opens. */
export function JobsMenu() {
  const t = useT()
  const jobs = useJobs((s) => s.jobs)
  const open = useJobs((s) => s.drawerOpen)
  const setOpen = useJobs((s) => s.setDrawerOpen)
  const ref = useRef<HTMLDivElement>(null)
  const visible = open && jobs.length > 0
  useLayer(visible, () => setOpen(false))
  useClickOutside(ref, visible, () => setOpen(false))

  if (!jobs.length) return null
  const running = jobs.filter((j) => !isFinished(j.progress.status))
  const current = running.reduce((n, j) => n + j.progress.current, 0)
  const total = running.reduce((n, j) => n + (j.progress.total || j.count), 0)
  const troubled = jobs.some((j) => j.progress.failedCount > 0 || j.progress.status === 'error')

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={`btn btn-ghost ${styles.button}`}
        aria-expanded={visible}
        onClick={() => setOpen(!open)}
        title={t('jobs.buttonTitle', { running: running.length, finished: jobs.length - running.length })}
        data-testid="jobs-button"
      >
        {t('jobs.button')}
        <span className={`${styles.buttonCount} mono`} data-trouble={troubled || undefined}>
          {running.length ? `${current}/${total}` : jobs.length}
        </span>
        {running.length > 0 && (
          <span className={styles.buttonMeter} aria-hidden>
            <span style={{ width: `${total ? (current / total) * 100 : 0}%` }} />
          </span>
        )}
      </button>
      {visible && <JobsDrawer jobs={jobs} />}
    </div>
  )
}

function JobsDrawer({ jobs }: { jobs: Job[] }) {
  const t = useT()
  const clearFinished = useJobs((s) => s.clearFinished)
  const anyFinished = jobs.some((j) => isFinished(j.progress.status))
  return (
    <section className={styles.drawer} aria-label={t('jobs.title')} data-testid="jobs-drawer">
      <header className={styles.head}>
        <h2 className={styles.title}>{t('jobs.title')}</h2>
        {anyFinished && (
          <button type="button" className="btn btn-ghost" onClick={clearFinished}>
            {t('jobs.clearFinished')}
          </button>
        )}
      </header>
      <ol className={styles.list}>
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} />
        ))}
      </ol>
    </section>
  )
}

function JobRow({ job }: { job: Job }) {
  const t = useT()
  const dismiss = useJobs((s) => s.dismiss)
  const setOpen = useJobs((s) => s.setDrawerOpen)
  const p = job.progress
  const finished = isFinished(p.status)
  const total = p.total || job.count
  const listed = p.failures.slice(0, MAX_LISTED)
  const unlisted = Math.max(p.failedCount, p.failures.length) - listed.length
  const failedIds = p.failures.map((f) => f.id).filter((id): id is number => id !== null)
  // A finished move or copy: the next step is usually to look at where the files went.
  const destination = job.kind === 'move' || job.kind === 'copy' ? job.destination : null

  const pickFailed = () => {
    const s = useApp.getState()
    s.setPage('library')
    s.setSelection(failedIds)
    setOpen(false)
  }

  return (
    <li className={styles.job} data-status={p.status} data-testid="job">
      <div className={styles.jobHead}>
        <strong className={styles.headline}>{jobHeadline(job)}</strong>
        {finished && (
          <button type="button" className="btn btn-ghost btn-icon" onClick={() => dismiss(job.id)} aria-label={t('jobs.dismiss')} title={t('jobs.dismiss')}>
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
      {job.adopted && <p className={styles.note}>{t('jobs.startedElsewhere')}</p>}
      {!finished && job.destination && (
        <p className={`${styles.note} mono`} title={job.destination}>
          {t(job.kind === 'reconnect' ? 'jobs.in' : 'jobs.to', { path: tailOfPath(job.destination, 44) })}
        </p>
      )}
      {!finished && (
        <>
          {p.phase && (
            <p className={styles.note}>{t(p.phase === 'details' ? 'import.phaseDetails' : 'import.phaseFiles')}</p>
          )}
          <div className={styles.meter} role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={p.current}>
            <span style={{ width: `${total ? (p.current / total) * 100 : 0}%` }} />
          </div>
          <div className={styles.numbers}>
            <span className="mono">{amount(p.current, total, p.unit)}</span>
            <span className={styles.item} title={p.currentItem ?? undefined}>
              {p.currentItem}
            </span>
            {canStop(job.kind) && (
              <button type="button" className="btn" onClick={() => void stopJob(job)} disabled={p.status === 'cancelling'}>
                {t('jobs.stop')}
              </button>
            )}
          </div>
        </>
      )}
      {finished && p.topTags.length > 0 && (
        <p className={styles.topTags} data-testid="job-top-tags">
          {t('jobs.topTags', { tags: p.topTags.slice(0, 6).map((x) => `${x.tag} ×${x.count}`).join(' · ') })}
        </p>
      )}
      {finished && (p.needsRestart || p.restartAdvised) && (
        <p className={styles.warnNote}>{t(p.needsRestart ? 'jobs.mustRestartNote' : 'jobs.needsRestart')}</p>
      )}
      {listed.length > 0 && (
        <ul className={styles.failures}>
          {listed.map((f, i) => (
            <li key={`${f.id}-${i}`}>
              <span className={styles.failName}>{f.name || nameFor(f.id)}</span>
              <span className={styles.failReason}>{f.reason}</span>
            </li>
          ))}
          {unlisted > 0 && <li className={styles.note}>{t('jobs.moreFailures', { n: unlisted })}</li>}
        </ul>
      )}
      {finished && p.toReview > 0 && (
        <button
          type="button"
          className="btn"
          onClick={() => {
            setOpen(false)
            useSelectionDialog.getState().showFor('missing', null, 1)
          }}
        >
          {t('jobs.review', { n: p.toReview })}
        </button>
      )}
      {job.undo && (
        <button type="button" className="btn" onClick={() => void undoJob(job)} disabled={job.undo.done}>
          {job.undo.done ? t('jobs.undone') : t('jobs.undo')}
        </button>
      )}
      {finished && failedIds.length > 0 && (
        <button type="button" className="btn" onClick={pickFailed}>
          {t('jobs.pickFailed', { n: failedIds.length })}
        </button>
      )}
      {finished && destination && (
        <button type="button" className="btn" onClick={() => void openFolderPath(destination)} data-testid="job-open-folder">
          {t('lib.file.openDestination')}
        </button>
      )}
    </li>
  )
}

const MB = 1024 * 1024

function amount(current: number, total: number, unit: 'images' | 'bytes'): string {
  if (unit === 'images') return `${current.toLocaleString()} / ${total.toLocaleString()}`
  const mb = (b: number) => Math.round(b / MB).toLocaleString()
  return total > 0 ? `${mb(current)} / ${mb(total)} MB` : `${mb(current)} MB`
}

function nameFor(id: number | null): string {
  if (id === null) return '?'
  return findLoadedImage(id)?.filename ?? `#${id}`
}
