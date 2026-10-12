import type { Batch, BatchItem } from '../../api/types'
import { useT, type MessageKey } from '../../i18n'
import { detectionsOf, erasedRegions, isTextRegion } from './detection'
import { useDetectBusy } from './detectRun'
import { TARGETS, type Target } from './detectSettings'
import { TARGET_LABEL } from './DetectPanel'
import type { RegionOp } from './ops'
import { HistoryButtons, Section } from './PanelParts'
import { reviewProgress } from './review'
import styles from './ReviewPanel.module.css'
import { initialEdit, keyOf, useCensorSession, type ImageEdit } from './session'
import tp from './ToolPanel.module.css'

/** What the review keys and buttons do (the editor owns moving between images). */
export interface ReviewActions {
  approve: () => void
  skip: () => void
  /** Region n, 1-based. */
  toggle: (n: number) => void
  toggleAll: () => void
  redetect: () => void
}

type Translate = ReturnType<typeof useT>

/** A region's name: body parts in the UI language, SAM3 words as typed, anything else as the model says it. */
export function regionName(region: RegionOp, t: Translate): string {
  if (isTextRegion(region)) return region.label
  const known = (TARGETS as readonly string[]).includes(region.label) ? TARGET_LABEL[region.label as Target] : null
  return known ? t(known) : region.label.replace(/_/g, ' ')
}

const MARK: Record<Mark, MessageKey> = {
  none: 'censor.review.markNone',
  waiting: 'censor.review.markWaiting',
  approved: 'censor.review.markApproved',
}

interface Props {
  batch: Batch
  item: BatchItem
  edit: ImageEdit | undefined
  actions: ReviewActions
}

type Mark = 'none' | 'waiting' | 'approved'

/** This image's regions, each switched off or on by its number key or a click. */
interface ListProps {
  regions: RegionOp[]
  /** Regions the eraser went over (the original shows there). */
  erased: ReadonlySet<string>
  mark: Mark
  actions: ReviewActions
}

function RegionList({ regions, erased, mark, actions }: ListProps) {
  const t = useT()
  return (
    <Section title={t('censor.review.regions', { n: regions.length })}>
      {regions.length === 0 ? (
        <p className={tp.note}>{t(mark === 'none' ? 'censor.review.notDetected' : 'censor.review.noRegions')}</p>
      ) : (
        <ol className={styles.regions} data-testid="censor-review-regions">
          {regions.map((region, i) => (
            <li key={region.id}>
              <button
                type="button"
                className={styles.region}
                aria-pressed={!region.off}
                onClick={() => actions.toggle(i + 1)}
                title={t(region.off ? 'censor.review.regionOff' : 'censor.review.regionOn')}
                data-testid="censor-review-region"
                data-erased={erased.has(region.id) || undefined}
              >
                <kbd>{i < 9 ? i + 1 : ' '}</kbd>
                <span className={styles.regionName}>
                  {regionName(region, t)}
                  {erased.has(region.id) && (
                    <span className={styles.manual} title={t('censor.review.erasedTip')}>
                      {t('censor.review.erased')}
                    </span>
                  )}
                </span>
                <span className={`${styles.conf} mono`}>{region.confidence === undefined ? '' : `${Math.round(region.confidence * 100)}%`}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {regions.length > 0 && (
        <button type="button" className="btn" onClick={actions.toggleAll} data-testid="censor-review-all">
          {t('censor.review.toggleAll')}
          <kbd>A</kbd>
        </button>
      )}
    </Section>
  )
}

/** The Review tab: progress, this image's regions (switch each off or on), approve / skip / re-detect. */
export function ReviewPanel({ batch, item, edit, actions }: Props) {
  const t = useT()
  const edits = useCensorSession((s) => s.edits)
  const busy = useDetectBusy((b) => b.busy[keyOf(batch.id, item.image_id)])
  const marks = batch.items.map((i) => ({ imageId: i.image_id, reviewed: (edits[keyOf(batch.id, i.image_id)] ?? initialEdit(i)).reviewed }))
  const progress = reviewProgress(marks)
  const current = edit ?? initialEdit(item)
  const regions = detectionsOf(current.ops)
  const mark: Mark = current.reviewed === true ? 'approved' : current.reviewed === false ? 'waiting' : 'none'

  return (
    <>
      <Section title={t('censor.review.progress', { done: progress.approved, total: progress.total })} testId="censor-review-progress">
        <div className={styles.meter} role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.approved}>
          <span style={{ width: `${progress.total ? (progress.approved / progress.total) * 100 : 0}%` }} />
        </div>
        <p className={styles.mark} data-mark={mark} data-testid="censor-review-mark">
          {busy === 'detect' ? t('censor.detect.running') : t(MARK[mark])}
        </p>
      </Section>
      <RegionList regions={regions} erased={erasedRegions(current.ops)} mark={mark} actions={actions} />
      <div className={styles.actions}>
        <button type="button" className="btn btn-primary" onClick={actions.approve} data-testid="censor-review-approve">
          {t('censor.review.approve')}
          <kbd>Enter</kbd>
        </button>
        <div className={tp.pair}>
          <button type="button" className="btn" onClick={actions.skip} data-testid="censor-review-skip">
            {t('censor.review.skip')}
            <kbd>S</kbd>
          </button>
          <button type="button" className="btn" onClick={actions.redetect} disabled={!!busy} data-testid="censor-review-redetect">
            {t(mark === 'none' ? 'censor.review.detect' : 'censor.review.redetect')}
            <kbd>{mark === 'none' ? 'D' : 'R'}</kbd>
          </button>
        </div>
      </div>
      <HistoryButtons batchId={batch.id} item={item} edit={edit} />
      <p className={tp.note}>{t('censor.review.keys')}</p>
    </>
  )
}
