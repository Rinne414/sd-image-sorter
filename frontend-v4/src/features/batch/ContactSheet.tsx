import { thumbnailUrl } from '../../api/client'
import type { BatchStep } from '../../api/types'
import { useT } from '../../i18n'
import { enabledSteps, stepState } from './batchLogic'
import { stepLabel } from './labels'
import styles from './ContactSheet.module.css'

const FRAMES = 4

/**
 * A batch on film: its first frames on a strip with sprocket holes, and how
 * many more are on the roll. Only real frames are drawn; an empty batch shows
 * one unexposed frame.
 */
export function ContactSheet({ ids, total, size = 'm' }: { ids: readonly number[]; total: number; size?: 'm' | 'l' }) {
  const t = useT()
  const shown = ids.slice(0, FRAMES)
  const more = Math.max(0, total - shown.length)
  return (
    <span className={styles.sheet} data-size={size} aria-hidden>
      {total === 0 && <span className={styles.blank}>{t('batch.sheet.empty')}</span>}
      {shown.map((id) => (
        <img key={id} className={styles.frame} src={thumbnailUrl(id, 256)} alt="" loading="lazy" decoding="async" draggable={false} />
      ))}
      {more > 0 && <span className={`${styles.more} mono`}>+{more}</span>}
    </span>
  )
}

/**
 * The switched-on steps as a row of segments: done, here, still to come,
 * exactly as the batch's step rail counts them. Without `current` it is a
 * preview of a batch not made yet, drawn in spans so it can sit in a button.
 */
export function StepTrack({ steps, current }: { steps: readonly BatchStep[]; current?: string | null }) {
  const t = useT()
  const on = enabledSteps(steps)
  if (current === undefined) {
    return (
      <span className={styles.track} aria-hidden>
        {on.map((step) => (
          <span key={step.id} className={styles.step} data-state="todo">
            {stepLabel(step.id, t)}
          </span>
        ))}
      </span>
    )
  }
  return (
    <ol className={styles.track} aria-label={t('batch.rail.title')} data-testid="step-track">
      {on.map((step) => {
        const state = stepState(steps, current, step.id)
        return (
          <li key={step.id} className={styles.step} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
            {stepLabel(step.id, t)}
          </li>
        )
      })}
    </ol>
  )
}
