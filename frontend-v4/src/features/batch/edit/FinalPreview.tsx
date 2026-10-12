import { useT } from '../../../i18n'
import { ruleTokens } from '../captionRules'
import type { DatasetForm } from '../datasetSettings'
import styles from './CaptionPanel.module.css'
import type { FinalCaption } from './captionApi'

interface Props {
  form: DatasetForm
  final: FinalCaption | undefined
  failed: string | null
  /** A change is still being saved: the text shown is the one before it. */
  pending: boolean
  /** Never edited: the export renders it from the template. */
  fromTemplate: boolean
  testId?: string
}

/**
 * The caption the export writes for this image, rendered by the backend from
 * the saved revision under the batch rules. Tokens the rules put in front are
 * locked here: they change in the training settings, for every image at once.
 */
export function FinalPreview({ form, final, failed, pending, fromTemplate, testId = 'edit-final' }: Props) {
  const t = useT()
  const tokens = final ? ruleTokens(final.caption, form) : []
  return (
    <section className={styles.final} aria-busy={pending || undefined}>
      <header className={styles.sectionHead}>
        <span className={styles.label}>{t('dataset.edit.finalTitle')}</span>
        {pending && <span className={styles.muted}>{t('dataset.edit.finalPending')}</span>}
      </header>
      {failed ? (
        <p className={styles.problem}>{t('dataset.preview.failed', { reason: failed })}</p>
      ) : !final ? (
        <p className={styles.muted}>{t('grid.loading')}</p>
      ) : tokens.length === 0 ? (
        <p className={styles.problem} data-testid={testId}>
          {t('dataset.preview.empty')}
        </p>
      ) : (
        <p className={styles.finalText} data-testid={testId} data-pending={pending || undefined}>
          {tokens.map(({ token, fromRule }, i) => (
            <span key={i}>
              {i > 0 && ', '}
              {fromRule ? (
                <b className={styles.ruleToken} title={t('dataset.edit.ruleToken')} data-testid="edit-rule-token">
                  {token}
                </b>
              ) : (
                token
              )}
            </span>
          ))}
        </p>
      )}
      {final?.problem && <p className={styles.problem}>{final.problem}</p>}
      {fromTemplate && <p className={styles.muted}>{t('dataset.edit.fromTemplate')}</p>}
    </section>
  )
}
