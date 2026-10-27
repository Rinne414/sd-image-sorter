import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { jobHeadline, pauseJob, stopJob, useJobs } from '../jobs/jobs'
import { isFinished } from '../jobs/progress'
import { Icon } from '../../ui/Icon'
import { indexStartedAt, latestIndexJob, startStyleIndex } from './indexJob'
import { useMap } from './mapStore'
import { formatRemaining, indexButton, remainingMs, startCard } from './status'
import styles from './StyleMap.module.css'

/** How often the time left is worked out again while the index runs. */
const TICK_MS = 1000

/**
 * The index of the current space: "Build" while pictures lack data, "Refresh"
 * once every picture has it; while it runs, its progress with Pause / Resume
 * and Cancel (the same job the Jobs drawer shows); after it, how it ended.
 */
export function IndexControls() {
  const t = useT()
  const space = useMap((s) => s.space)
  const points = useMap((s) => s.points)
  const token = useMap((s) => s.token)
  const job = useJobs((s) => latestIndexJob(s.jobs))
  const running = job !== null && !isFinished(job.progress.status)
  const now = useNow(running)

  if (running && job) {
    const p = job.progress
    const total = Math.max(p.total, job.count)
    const done = Math.min(total, p.current)
    const percent = total > 0 ? Math.round((done / total) * 100) : 0
    const startedAt = indexStartedAt.get(job.id) ?? null
    const left = p.paused ? null : remainingMs(done, total, startedAt, now)
    let text = t('stylemap.index.running', { done, total })
    if (left !== null) text += ` · ${t('stylemap.index.remaining', { time: formatRemaining(left) })}`
    if (p.paused) text += ` · ${t('stylemap.index.paused')}`
    return (
      <div className={styles.index} data-state={p.paused ? 'paused' : 'running'} data-testid="stylemap-index">
        <div className={styles.meter} role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <span style={{ width: `${percent}%` }} />
        </div>
        <span className={styles.indexText} title={p.currentItem ?? undefined} data-testid="stylemap-index-progress">
          {text}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void pauseJob(job, !p.paused)}
          disabled={p.status === 'cancelling'}
          data-testid="stylemap-index-pause"
        >
          {t(p.paused ? 'stylemap.index.resume' : 'stylemap.index.pause')}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void stopJob(job)} disabled={p.status === 'cancelling'} data-testid="stylemap-index-cancel">
          {t('stylemap.index.cancel')}
        </button>
      </div>
    )
  }

  // The start card offers the build while the map is empty: one primary per screen.
  const button = startCard(points, space, false) ? null : indexButton(points, space, false)
  return (
    <div className={styles.index} data-state="idle" data-testid="stylemap-index">
      {job && (
        <span className={styles.indexDone} data-status={job.progress.status} data-testid="stylemap-index-result">
          <span className={styles.indexDoneText}>{jobHeadline(job)}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            onClick={() => useJobs.getState().dismiss(job.id)}
            aria-label={t('jobs.dismiss')}
            title={t('jobs.dismiss')}
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      )}
      {button && (
        <button
          type="button"
          className={button.primary ? 'btn btn-primary' : 'btn'}
          onClick={() => void startStyleIndex(space, token)}
          data-testid="stylemap-build"
        >
          {t(button.key)}
        </button>
      )}
    </div>
  )
}

/** The clock, ticking only while something shows a time left. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [ticking])
  return now
}
