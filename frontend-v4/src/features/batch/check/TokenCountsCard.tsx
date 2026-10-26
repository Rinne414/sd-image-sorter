import { useT } from '../../../i18n'
import styles from './CheckStep.module.css'
import { prepareTokenizers, useTokenizerStatus } from './tokenApi'

const MB = 1_000_000

/**
 * Anima's exact token counts: ready, or a one-time download of two small
 * tokenizer files (about 14 MB). Until then the check says its counts are
 * estimates; nothing waits on the download.
 */
export function TokenCountsCard() {
  const t = useT()
  const status = useTokenizerStatus(true)
  const s = status.data
  const size = s ? Math.max(1, Math.round(s.download_bytes / MB)) : 14

  return (
    <section className={styles.block} data-testid="check-tokenizers">
      <h2 className={styles.blockTitle}>{t('dataset.check.tokenizers.title')}</h2>
      {status.isError ? (
        <p className={styles.sourceWarn}>{t('dataset.check.failed', { reason: status.error.message })}</p>
      ) : !s ? (
        <p className={styles.note}>{t('grid.loading')}</p>
      ) : s.available ? (
        <p className={styles.note} data-testid="tokenizers-ready">
          {t('dataset.check.tokenizers.ready')}
        </p>
      ) : (
        <>
          <p className={styles.note} data-testid="tokenizers-estimate">
            {t('dataset.check.tokenizers.estimate', { mb: size })}
          </p>
          {!s.tokenizers_package && <p className={styles.hint}>{t('dataset.check.tokenizers.package')}</p>}
          {s.error && <p className={styles.sourceWarn}>{t('dataset.check.failed', { reason: s.error })}</p>}
          <div className={styles.issueActions}>
            <button type="button" className="btn" disabled={s.preparing} onClick={() => void prepareTokenizers()} data-testid="tokenizers-download">
              {s.preparing ? t('dataset.check.tokenizers.busy') : s.error ? t('dataset.check.retry') : t('dataset.check.tokenizers.download', { mb: size })}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
