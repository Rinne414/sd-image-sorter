import { useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { fileSize } from '../../lib/format'
import { parentFolder, tailOfPath } from '../../lib/paths'
import { Dialog } from '../../ui/Dialog'
import { FolderChooser } from '../../ui/FolderChooser'
import styles from './MissingDialog.module.css'
import { clearMissing, settleReview, startReconnect, useMissingGroups, useRepairReviews, type MissingGroup, type Review } from './missing'

const REASON: Record<MissingGroup['reason'], MessageKey> = {
  file_deleted: 'missing.reason.file',
  folder_deleted: 'missing.reason.folder',
  location_unreachable: 'missing.reason.unreachable',
}

/** Places worth searching first: the folders the missing files used to sit in. */
const SHORTCUT_COUNT = 5

export function MissingDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const summary = useMissingGroups()
  const reviews = useRepairReviews()
  const [choosing, setChoosing] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const groups = summary.data?.groups ?? []
  const total = summary.data?.total ?? 0

  const formerHomes = [...new Set(groups.map((g) => parentFolder(g.location)).filter((p): p is string => !!p))].slice(0, SHORTCUT_COUNT)

  const footer = (
    <button type="button" className="btn btn-ghost" onClick={onClose}>
      {t('common.close')}
    </button>
  )

  return (
    <>
      <Dialog title={t('missing.title', { n: total })} onClose={onClose} footer={footer} testId="missing-dialog" wide>
        <p className={styles.lead}>{t('missing.lead')}</p>
        <button type="button" className="btn btn-primary" onClick={() => setChoosing(true)} disabled={total === 0}>
          {t('missing.find')}
        </button>

        {(reviews.data?.items.length ?? 0) > 0 && (
          <section className={styles.section} data-testid="missing-reviews">
            <h3 className={styles.heading}>{t('missing.reviewTitle', { n: reviews.data?.total ?? 0 })}</h3>
            <p className={styles.note}>{t('missing.reviewLead')}</p>
            <ul className={styles.reviews}>
              {reviews.data?.items.map((r) => (
                <ReviewRow key={r.review_id} review={r} />
              ))}
            </ul>
          </section>
        )}

        <section className={styles.section}>
          <h3 className={styles.heading}>{t('missing.byFolder')}</h3>
          {summary.isPending && <p className={styles.note}>{t('picker.loading')}</p>}
          {summary.data && groups.length === 0 && <p className={styles.note}>{t('missing.none')}</p>}
          <ul className={styles.groups} data-testid="missing-groups">
            {groups.map((g) => (
              <li key={g.location} className={styles.group}>
                <div className={styles.groupMain}>
                  <span className={`${styles.location} mono`} title={g.location}>
                    {tailOfPath(g.location, 56)}
                  </span>
                  <span className={styles.reason} data-reason={g.reason}>
                    {t(REASON[g.reason])}
                  </span>
                  <span className={styles.count}>{t('missing.count', { n: g.count })}</span>
                  {g.user_work_total > 0 && <span className={styles.work}>{t('missing.userWork', { n: g.user_work_total })}</span>}
                </div>
                {confirming === g.location ? (
                  <div className={styles.confirm} role="group">
                    <span>{g.user_work_total > 0 ? t('missing.confirmWork', { n: g.count, k: g.user_work_total }) : t('missing.confirm', { n: g.count })}</span>
                    <button type="button" className="btn btn-ghost" onClick={() => setConfirming(null)}>
                      {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => void clearMissing(g.location).then(() => setConfirming(null))}
                    >
                      {t('missing.clearOk', { n: g.count })}
                    </button>
                  </div>
                ) : g.clearable ? (
                  <button type="button" className={styles.fix} onClick={() => setConfirming(g.location)}>
                    {t('missing.clear')}
                  </button>
                ) : (
                  <span className={styles.note}>{t('missing.blocked')}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      </Dialog>
      {choosing && (
        <FolderChooser
          title={t('missing.chooseTitle')}
          confirmLabel={t('missing.chooseOk')}
          start={formerHomes[0] ?? null}
          shortcuts={[{ heading: t('missing.formerHomes'), paths: formerHomes }]}
          allowNewFolder={false}
          onChoose={startReconnect}
          onClose={() => setChoosing(false)}
          testId="missing-chooser"
        />
      )}
    </>
  )
}

function ReviewRow({ review }: { review: Review }) {
  const t = useT()
  const [chosen, setChosen] = useState<number | null>(review.candidates[0]?.image_id ?? null)
  return (
    <li className={styles.review}>
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
