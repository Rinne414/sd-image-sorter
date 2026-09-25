import type { Batch, BatchKind } from '../../api/types'
import { useT, type MessageKey } from '../../i18n'
import styles from './StepPanel.module.css'
import { isKnownStep, stepLabel } from './labels'

/** What each step will do. Export differs by kind; the rest is the same everywhere. */
function whatKey(step: string, kind: BatchKind): MessageKey {
  if (step === 'export') return `batch.panel.export.${kind}`
  if (isKnownStep(step)) return `batch.panel.${step}` as MessageKey
  return 'batch.panel.unknown'
}

interface Props {
  batch: Batch
  step: string | null
  next: string | null
  onNext: (step: string) => void
}

/** A step a later V4 slice builds: says honestly what it will do and to which images. No fake controls. */
export function StepPanel({ batch, step, next, onNext }: Props) {
  const t = useT()
  if (step === null) return null
  const n = batch.item_count

  return (
    <section className={styles.panel} data-testid="step-panel" data-step={step}>
      <div className={styles.sheet}>
        <span className={`${styles.kicker} mono`}>{t('batch.panel.kicker')}</span>
        <h2 className={styles.title}>{stepLabel(step, t)}</h2>
        <p className={styles.what}>{t(whatKey(step, batch.kind), { n })}</p>
        <p className={styles.applies}>{n === 0 ? t('batch.panel.appliesNone') : t('batch.panel.applies', { n })}</p>
        {step === 'censor' && n > 0 && <p className={styles.applies}>{t('batch.panel.censored', { c: batch.censored_count })}</p>}
        <p className={styles.note}>{t('batch.panel.notYet')}</p>
        <div className={styles.actions}>
          {next && (
            <button type="button" className="btn" onClick={() => onNext(next)} data-testid="step-next">
              {t('batch.panel.next', { step: stepLabel(next, t) })}
            </button>
          )}
          <a className="btn btn-ghost" href="/">
            {t('planned.openV3')}
          </a>
        </div>
      </div>
    </section>
  )
}
