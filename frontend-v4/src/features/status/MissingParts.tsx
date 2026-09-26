import { useRef, useState } from 'react'
import { useT } from '../../i18n'
import { fileSize } from '../../lib/format'
import { tailOfPath } from '../../lib/paths'
import { Dialog } from '../../ui/Dialog'
import styles from './MissingDialog.module.css'
import { clearAllMissing, removeOldRecords, settleReview, useAlreadyIndexed, type MissingSummary, type Review } from './missing'

// The missing-files dialog's parts: an ambiguous match to settle (with a look
// at the found file), the last search's files that were already in the
// library, and clearing every record (asked first, Cancel focused).

/** The found file, small enough to sit beside its candidates. */
const PREVIEW_PX = 160

export function ReviewRow({ review }: { review: Review }) {
  const t = useT()
  const [chosen, setChosen] = useState<number | null>(review.candidates[0]?.image_id ?? null)
  const preview = `/api/image-preview-by-path?size=${PREVIEW_PX}&path=${encodeURIComponent(review.found_path)}`
  return (
    <li className={styles.review}>
      <div className={styles.reviewBody}>
        {review.found_exists && <img className={styles.preview} src={preview} alt={t('missing.reviewPreview')} loading="lazy" data-testid="review-preview" />}
        <div className={styles.reviewMain}>
          <p className={styles.found}>
            {t('missing.found')} <span className="mono">{review.found_path}</span>
          </p>
          <div role="radiogroup" aria-label={review.filename}>
            {review.candidates.map((c) => (
              <label key={c.image_id} className={styles.candidate}>
                <input type="radio" name={`review-${review.review_id}`} checked={chosen === c.image_id} onChange={() => setChosen(c.image_id)} />
                <span className="mono">{c.path}</span>
                <span className={styles.note}>{fileSize(c.file_size)}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
      <div className={styles.reviewActions}>
        <button type="button" className="btn" onClick={() => void settleReview(review.review_id, null)}>
          {t('missing.skip')}
        </button>
        <button type="button" className="btn btn-primary" disabled={chosen === null} onClick={() => void settleReview(review.review_id, chosen)}>
          {t('missing.pick')}
        </button>
      </div>
    </li>
  )
}

/** Files the last search found already in the library: their old records can go. */
export function AlreadySection() {
  const t = useT()
  const { samples, total } = useAlreadyIndexed()
  const [confirming, setConfirming] = useState<number[] | null>(null)
  if (samples.length === 0) return null
  const remove = async (ids: number[]) => {
    if (await removeOldRecords(ids)) setConfirming(null)
  }
  return (
    <section className={styles.section} data-testid="missing-already">
      <h3 className={styles.heading}>{t('missing.already.title', { n: total })}</h3>
      <p className={styles.note}>{t('missing.already.lead')}</p>
      {total > samples.length && <p className={styles.note}>{t('missing.already.more', { shown: samples.length })}</p>}
      <ul className={styles.groups}>
        {samples.map((s) => (
          <li key={s.old_image_id} className={styles.group}>
            <span className={styles.location}>{s.filename}</span>
            <span className={`${styles.pathLine} mono`} title={s.old_path ?? undefined}>
              {t('missing.already.old')} {s.old_path ? tailOfPath(s.old_path, 70) : '—'}
            </span>
            <span className={`${styles.pathLine} mono`} title={s.existing_path ?? undefined}>
              {t('missing.already.existing')} {s.existing_path ? tailOfPath(s.existing_path, 70) : '—'}
            </span>
            <button type="button" className={styles.fix} onClick={() => setConfirming([s.old_image_id])}>
              {t('missing.already.remove')}
            </button>
          </li>
        ))}
      </ul>
      {confirming ? (
        <div className={styles.confirm} role="group" data-testid="missing-already-confirm">
          <span>{t('missing.already.confirm', { n: confirming.length })}</span>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirming(null)}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void remove(confirming)}>
            {t('missing.already.ok', { n: confirming.length })}
          </button>
        </div>
      ) : (
        samples.length > 1 && (
          <button type="button" className={`btn ${styles.after}`} onClick={() => setConfirming(samples.map((s) => s.old_image_id))}>
            {t('missing.already.removeAll', { n: samples.length })}
          </button>
        )
      )}
    </section>
  )
}

/** Clearing every clearable record: asked in its own dialog with Cancel focused. */
export function ClearAllConfirm({ summary, onClose }: { summary: MissingSummary; onClose: () => void }) {
  const t = useT()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const n = summary.clearable_total
  const work = summary.clearable_user_work_total ?? 0
  const go = async () => {
    setBusy(true)
    const ok = await clearAllMissing()
    setBusy(false)
    if (ok) onClose()
  }
  const footer = (
    <>
      <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn btn-danger" onClick={() => void go()} disabled={busy}>
        {t('missing.clearOk', { n })}
      </button>
    </>
  )
  return (
    <Dialog title={t('missing.clearAll.title', { n })} onClose={onClose} footer={footer} testId="missing-clear-all" initialFocus={cancelRef}>
      <p className={styles.lead}>{t('missing.clearAll.body')}</p>
      {work > 0 && <p className={styles.warn}>{t('missing.clearAll.work', { k: work })}</p>}
      {summary.blocked_total > 0 && <p className={styles.note}>{t('missing.clearAll.blocked', { b: summary.blocked_total })}</p>}
    </Dialog>
  )
}
