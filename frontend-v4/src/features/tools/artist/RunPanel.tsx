import { useMemo, useState } from 'react'
import { useImageCount } from '../../../api/queries'
import { useApp } from '../../../state/store'
import { useToasts } from '../../../ui/toasts'
import { stopJob, useJobs, type Job } from '../../jobs/jobs'
import { isFinished } from '../../jobs/progress'
import { currentLibraryParams } from '../../library/params'
import { matchingIds } from '../../selection/invert'
import { useArtistStats } from './artistApi'
import { setArtistPrefs, useArtistPrefs } from './artistPrefs'
import styles from './Artist.module.css'
import { useAT } from './artistText'
import { useArtistView } from './artistView'
import { identifyArtists } from './identify'
import { ModelLine } from './ModelLine'

// 识别: which images (the ones sent here, the library's picks, or the
// current filter), whether to skip the ones with a result, and the run itself
// (its progress, with Stop; the drawer has the same job).

type Source = 'sent' | 'picks' | 'filter'

/** The choice the user made, while it still has images; else the images sent here, the picks, the filter. */
function sourceOf(chosen: Source | null, sent: number[] | null, picks: readonly number[]): Source {
  const has = (s: Source) => s === 'filter' || (s === 'sent' ? !!sent?.length : picks.length > 0)
  if (chosen && has(chosen)) return chosen
  return (['sent', 'picks', 'filter'] as const).find(has) ?? 'filter'
}

function useSources() {
  const libraryId = useApp((s) => s.libraryId)
  const queryText = useApp((s) => s.queryText)
  const scope = useApp((s) => s.scope)
  const picks = useApp((s) => s.selection)
  const sent = useArtistView((s) => s.sent)
  const params = useMemo(currentLibraryParams, [libraryId, queryText, scope])
  const filterCount = useImageCount(params).data ?? null
  const scoped = scope.generators.length > 0 || scope.folder !== null || scope.favorites
  return { picks, sent, params, filterCount, filterText: queryText.trim(), scoped }
}

function RunningLine({ job }: { job: Job }) {
  const t = useAT()
  const p = job.progress
  const stopping = p.status === 'cancelling'
  const pct = p.total > 0 ? Math.min(100, Math.round((p.current / p.total) * 100)) : 0
  const line = p.current === 0 && p.currentItem ? p.currentItem : [t('artist.run.progress', { done: p.current, total: p.total }), p.currentItem].filter(Boolean).join(' · ')
  return (
    <div className={styles.running} data-testid="artist-running">
      <span className={styles.runText}>{line}</span>
      <div className={styles.progress} aria-hidden>
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className={styles.runRow}>
        <button type="button" className="btn" onClick={() => void stopJob(job)} disabled={stopping} data-testid="artist-stop">
          {stopping ? t('artist.run.stopping') : t('artist.run.stop')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => useJobs.getState().setDrawerOpen(true)}>
          {t('artist.run.jobs')}
        </button>
      </div>
    </div>
  )
}

function Choice({ value, current, onPick, label, detail }: { value: Source; current: Source; onPick: (s: Source) => void; label: string; detail?: string }) {
  return (
    <label className={styles.choice}>
      <input type="radio" name="artist-source" checked={current === value} onChange={() => onPick(value)} data-testid={`artist-source-${value}`} />
      <span>
        <span>{label}</span>
        {detail && <span className={styles.filterText}>{detail}</span>}
      </span>
    </label>
  )
}

export function RunPanel() {
  const t = useAT()
  const { picks, sent, params, filterCount, filterText, scoped } = useSources()
  const skip = useArtistPrefs((s) => s.skipExisting)
  const withResult = useArtistStats().data?.identified_images ?? 0
  const job = useJobs((s) => s.jobs.find((j) => j.kind === 'artist' && !isFinished(j.progress.status)))
  const [chosen, setChosen] = useState<Source | null>(null)
  const [resolving, setResolving] = useState(false)
  const source = sourceOf(chosen, sent, picks)
  const count = source === 'sent' ? (sent?.length ?? 0) : source === 'picks' ? picks.length : filterCount

  const go = async () => {
    setResolving(true)
    try {
      const ids = source === 'sent' ? (sent ?? []) : source === 'picks' ? picks : await matchingIds(params)
      await identifyArtists(ids)
    } catch (error) {
      useToasts.getState().push(t('artist.job.startFailed', { reason: (error as Error).message }), 'error')
    } finally {
      setResolving(false)
    }
  }

  const filterDetail = [filterText || t('artist.run.filterWhole'), scoped ? t('artist.run.scoped') : ''].filter(Boolean).join(' · ')
  return (
    <section className={styles.block} data-testid="artist-run">
      <h3 className={styles.blockTitle}>{t('artist.run.title')}</h3>
      <fieldset className={styles.choices} disabled={!!job || resolving}>
        <legend className={styles.subLabel}>{t('artist.run.which')}</legend>
        {!!sent?.length && <Choice value="sent" current={source} onPick={setChosen} label={t('artist.run.sent', { n: sent.length })} />}
        {picks.length > 0 && <Choice value="picks" current={source} onPick={setChosen} label={t('artist.run.picks', { n: picks.length })} />}
        <Choice
          value="filter"
          current={source}
          onPick={setChosen}
          label={filterCount === null ? t('artist.run.filterCounting') : t('artist.run.filter', { n: filterCount })}
          detail={filterDetail}
        />
      </fieldset>
      <label className={styles.check}>
        <input type="checkbox" checked={skip} onChange={(e) => setArtistPrefs({ skipExisting: e.target.checked })} disabled={!!job} data-testid="artist-skip" />
        <span>
          <span>{t('artist.run.skip')}</span>
          <span className={styles.hint}>{withResult > 0 ? t('artist.run.skipHint', { n: withResult }) : t('artist.run.skipAll')}</span>
        </span>
      </label>
      {job ? (
        <RunningLine job={job} />
      ) : (
        <div className={styles.runRow}>
          <button type="button" className="btn btn-primary" onClick={() => void go()} disabled={resolving || !count} data-testid="artist-go">
            {resolving ? t('artist.run.resolving') : count ? t('artist.run.go', { n: count }) : t('artist.run.nothing')}
          </button>
        </div>
      )}
      <ModelLine />
    </section>
  )
}
