import { useEffect, useState } from 'react'
import { queryClient } from '../../api/queryClient'
import { useT } from '../../i18n'
import { useToasts } from '../../ui/toasts'
import { taggerInfo } from '../tagging/taggers'
import { rethreshold, useScoreStats, type RethresholdReport, type WriteFilters } from './datasetTagApi'
import styles from './TagStep.module.css'

/** Quiet time after the slider stops before the dry run asks. */
const DRY_RUN_AFTER_MS = 350
/** Where the slider starts for a tagger whose default is not known. */
const FALLBACK_THRESHOLD = 0.35

interface Props {
  ids: readonly number[]
  /** Folder images: they have no stored scores. */
  folderCount: number
  filters: WriteFilters
  /** A tagger's own default threshold, where the slider starts. */
  defaultFor: (model: string) => number | undefined
  /** After new tags were written, with the model they came from. */
  onApplied: (model: string) => void
}

/** After a run: move the thresholds and see (then apply) the new tags, from stored scores, with no new tagging. */
export function RethresholdPanel({ ids, folderCount, filters, defaultFor, onApplied }: Props) {
  const t = useT()
  const stats = useScoreStats()
  const models = stats.data?.models ?? []
  const floor = stats.data?.floor ?? 0.05
  const [model, setModel] = useState<string | null>(null)
  const [picked, setPicked] = useState<number | null>(null)
  const [report, setReport] = useState<RethresholdReport | null>(null)
  const [busy, setBusy] = useState(false)
  const chosen = model ?? models[0]?.model ?? null
  const threshold = picked ?? (chosen ? defaultFor(chosen) : undefined) ?? FALLBACK_THRESHOLD

  useEffect(() => {
    if (!chosen || ids.length === 0) return
    let live = true
    const timer = setTimeout(() => {
      rethreshold(ids, chosen, threshold, true, filters)
        .then((r) => live && setReport(r))
        .catch(() => live && setReport(null))
    }, DRY_RUN_AFTER_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [chosen, threshold, ids, filters])

  if (models.length === 0 || ids.length === 0) return null

  const apply = async () => {
    if (!chosen) return
    setBusy(true)
    try {
      const r = await rethreshold(ids, chosen, threshold, false, filters)
      useToasts.getState().push(t('dataset.re.applied', { n: r.images_changed, added: r.tags_added, removed: r.tags_removed }))
      for (const key of [['images'], ['image'], ['tag-score-stats']]) void queryClient.invalidateQueries({ queryKey: key })
      setReport({ ...r, images_changed: 0, tags_added: 0, tags_removed: 0 })
      onApplied(chosen)
    } catch (error) {
      useToasts.getState().push(t('error.generic', { reason: (error as Error).message }), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.block} aria-labelledby="tag-re" data-testid="rethreshold">
      <h3 id="tag-re" className={styles.blockTitle}>
        {t('dataset.re.title')}
      </h3>
      <p className={styles.hint}>{t('dataset.re.lead')}</p>
      <div className={styles.row}>
        <label className={styles.field}>
          <span>{t('dataset.re.model')}</span>
          <select
            value={chosen ?? ''}
            onChange={(e) => {
              setModel(e.target.value)
              setPicked(null)
            }}
            data-testid="re-model"
          >
            {models.map((m) => (
              <option key={m.model} value={m.model}>
                {taggerInfo(m.model).label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>{t('dataset.re.threshold', { n: threshold.toFixed(2) })}</span>
          <input type="range" min={Math.max(0.05, floor)} max={0.95} step={0.01} value={threshold} onChange={(e) => setPicked(Number(e.target.value))} data-testid="re-threshold" />
        </label>
      </div>
      {report && (
        <p className={styles.note} data-testid="re-report">
          {report.with_scores === 0
            ? t('dataset.re.noScores')
            : t('dataset.re.would', { n: report.images_changed, added: report.tags_added, removed: report.tags_removed })}
          {report.skipped_no_scores > 0 && ` ${t('dataset.re.skipped', { n: report.skipped_no_scores })}`}
          {folderCount > 0 && ` ${t('dataset.re.folder', { n: folderCount })}`}
        </p>
      )}
      <div className={styles.actions}>
        <button type="button" className="btn" onClick={() => void apply()} disabled={busy || !report || report.images_changed === 0} data-testid="re-apply">
          {t('dataset.re.apply')}
        </button>
      </div>
    </section>
  )
}
