import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { rawJson } from '../../../api/raw'
import { useT, type MessageKey } from '../../../i18n'
import { useApp } from '../../../state/store'
import { useJobs, type Job } from '../../jobs/jobs'
import { isFinished, type JobKind } from '../../jobs/progress'
import { startRepair, type RepairKind } from '../../status/reparse'
import { Section } from '../about/Section'
import styles from './LibrarySettings.module.css'
import { readRepairCounts } from './repairCounts'

const REPAIR_KINDS: readonly JobKind[] = ['reparse', 'reread', 'recomfy']

/** The newest repair job of this kind, running or finished. */
const lastJob = (jobs: Job[], kind: RepairKind) => jobs.find((j) => j.kind === kind)

/**
 * Settings › Library › Repair prompts and text: recover the text of images
 * that have none, and read every ComfyUI prompt again with the current reader.
 * Both run as jobs (progress and Stop in the Jobs drawer) and report here what
 * they found; the rail's fixes start the same recovery.
 */
export function RepairSection() {
  const t = useT()
  const libraryId = useApp((s) => s.libraryId)
  const jobs = useJobs((s) => s.jobs)
  const running = jobs.some((j) => REPAIR_KINDS.includes(j.kind) && !isFinished(j.progress.status))
  const counts = useQuery({
    queryKey: ['metadata-health', libraryId],
    queryFn: async ({ signal }) => readRepairCounts(await rawJson<unknown>('GET', '/api/metadata/health', { signal })),
    staleTime: 0,
  })
  // A run that ended changes the numbers: count again.
  const { refetch } = counts
  useEffect(() => {
    if (!running) void refetch()
  }, [running, refetch])

  const n = counts.data
  return (
    <Section title={t('partialsa.repair.title')} testId="libset-repair">
      <p className={styles.hint}>{t('partialsa.repair.hint')}</p>
      <RepairRow
        kind="reparse"
        name="recover"
        title="partialsa.repair.recover.title"
        body="partialsa.repair.recover.body"
        count={n ? (n.missingText > 0 ? t('partialsa.repair.recover.count', { n: n.missingText }) : t('partialsa.repair.recover.nothing')) : null}
        available={n ? n.missingText : null}
        total={n?.missingText ?? 0}
        job={lastJob(jobs, 'reparse')}
        busy={running}
        failed={counts.isError}
      />
      <RepairRow
        kind="recomfy"
        name="comfy"
        title="partialsa.repair.comfy.title"
        body="partialsa.repair.comfy.body"
        count={n ? (n.comfy > 0 ? t('partialsa.repair.comfy.count', { n: n.comfy }) : t('partialsa.repair.comfy.nothing')) : null}
        available={n ? n.comfy : null}
        total={n?.comfy ?? 0}
        job={lastJob(jobs, 'recomfy')}
        busy={running}
        failed={counts.isError}
      />
    </Section>
  )
}

interface RowProps {
  kind: RepairKind
  name: 'recover' | 'comfy'
  title: MessageKey
  body: MessageKey
  /** The sentence about how many; null while it is being counted. */
  count: string | null
  /** How many it can work on; null while unknown. Zero: nothing to do. */
  available: number | null
  total: number
  job: Job | undefined
  busy: boolean
  failed: boolean
}

function RepairRow({ kind, name, title, body, count, available, total, job, busy, failed }: RowProps) {
  const t = useT()
  // Counting failed: the run can still be started (the number was only a guide).
  const nothing = available === 0 && !failed
  const thisRunning = !!job && !isFinished(job.progress.status)
  return (
    <div className={styles.repair} data-testid={`repair-${name}`}>
      <div className={styles.repairText}>
        <strong>{t(title)}</strong>
        <p className={styles.hint}>{t(body)}</p>
        <p className={styles.repairCount} data-testid={`repair-${name}-count`}>
          {failed ? t('partialsa.repair.countFailed') : (count ?? t('partialsa.repair.counting'))}
        </p>
        {job && isFinished(job.progress.status) && <RepairResultLine job={job} />}
      </div>
      <button
        type="button"
        className="btn"
        onClick={() => void startRepair(kind, total)}
        disabled={busy || nothing}
        data-testid={`repair-${name}-start`}
      >
        {thisRunning ? t('partialsa.repair.running') : t('partialsa.repair.start')}
      </button>
    </div>
  )
}

/** What the last run of this repair did, said plainly. */
function RepairResultLine({ job }: { job: Job }) {
  const t = useT()
  const p = job.progress
  let text: string
  if (p.status === 'error') text = t('partialsa.repair.result.failed', { reason: p.message || '?' })
  else if (p.status === 'cancelled') text = t('partialsa.repair.result.stopped')
  else if (p.repair?.kind === 'recover') text = t('partialsa.repair.result.recover', { recovered: p.repair.recovered, captions: p.repair.captions, still: p.repair.still })
  else if (p.repair?.kind === 'comfy') text = t('partialsa.repair.result.comfy', { changed: p.repair.changed, unchanged: p.repair.unchanged, kept: p.repair.kept, missing: p.repair.missing })
  else return null
  return (
    <p className={styles.repairResult} data-tone={p.status === 'error' ? 'error' : undefined} role="status" data-testid={`repair-${job.kind === 'recomfy' ? 'comfy' : 'recover'}-result`}>
      <b>{t('partialsa.repair.last')}</b> {text}
    </p>
  )
}
