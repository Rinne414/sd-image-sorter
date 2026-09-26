import { useState } from 'react'
import type { Batch } from '../../../api/types'
import { useT } from '../../../i18n'
import { isFinished } from '../../jobs/progress'
import { useJobs } from '../../jobs/jobs'
import styles from './CheckStep.module.css'
import { runPurity, usePurityResults, usePurityStatus } from './purityRun'

const useBusy = () => useJobs((s) => s.jobs.some((j) => (j.kind === 'purity' || j.kind === 'purityget') && !isFinished(j.progress.status)))

/** The analysis needs at least this many Library images to compare. */
const MIN_IMAGES = 2

interface Props {
  batch: Batch
  ids: readonly number[]
  folderCount: number
}

/** Character purity (CCIP): run on demand (it is an AI model), advisory only. */
export function PurityCard({ batch, ids, folderCount }: Props) {
  const t = useT()
  const status = usePurityStatus()
  const busy = useBusy()
  const outcome = usePurityResults((s) => s.byBatch[batch.id])
  const [threshold, setThreshold] = useState<number | null>(null)
  const available = status.data?.available ?? false
  const value = threshold ?? status.data?.default_threshold ?? 0.178
  const outliers = outcome?.items.filter((i) => i.outlier).length ?? 0
  const start = () => void runPurity(batch.id, [...ids], threshold, available)

  return (
    <section className={styles.block} data-testid="check-purity">
      <h2 className={styles.blockTitle}>{t('dataset.check.purity.title')}</h2>
      <p className={styles.note}>{t('dataset.check.purity.what')}</p>
      {folderCount > 0 && <p className={styles.sourceNa}>{t('dataset.check.notForFolder', { n: folderCount })}</p>}
      {status.isError ? (
        <p className={styles.warn}>{t('dataset.check.failed', { reason: status.error.message })}</p>
      ) : ids.length < MIN_IMAGES ? (
        <p className={styles.hint}>{t('dataset.check.purity.tooFew')}</p>
      ) : (
        <>
          <label className={styles.field}>
            <span>{t('dataset.check.purity.threshold')}</span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={value}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v) && v >= 0 && v <= 1) setThreshold(v)
              }}
            />
          </label>
          {!available && status.data && <p className={styles.hint}>{t('dataset.check.purity.download')}</p>}
          <button type="button" className="btn" disabled={busy || !status.data} onClick={start} data-testid="check-purity-run">
            {busy ? t('dataset.check.purity.busy') : available ? t('dataset.check.purity.run', { n: ids.length }) : t('dataset.check.purity.downloadRun', { n: ids.length })}
          </button>
        </>
      )}
      {outcome && (
        <div className={styles.purityResult} data-testid="check-purity-result">
          <p className={styles.note}>
            {t('dataset.check.purity.result', { n: outcome.extracted, bad: outliers, threshold: outcome.threshold.toFixed(3) })}
            {outcome.failed > 0 && ` ${t('dataset.check.purity.unread', { n: outcome.failed })}`}
          </p>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => usePurityResults.setState((s) => ({ byBatch: { ...s.byBatch, [batch.id]: undefined } }))}
          >
            {t('dataset.check.purity.clear')}
          </button>
        </div>
      )}
    </section>
  )
}
