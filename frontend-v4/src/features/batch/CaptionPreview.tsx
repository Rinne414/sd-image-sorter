import { useT } from '../../i18n'
import { ruleTokens } from './captionRules'
import type { DatasetForm } from './datasetSettings'
import styles from './DatasetSettings.module.css'
import { PREVIEW_LIMIT, type PreviewItem, type useDatasetSettings } from './useDatasetSettings'

/** One final caption; the tokens the batch rules put in front are marked. */
function Caption({ text, form }: { text: string; form: DatasetForm }) {
  const tokens = ruleTokens(text, form)
  return (
    <p className={styles.caption} data-testid="preview-caption">
      {tokens.map(({ token, fromRule }, i) => (
        <span key={i}>
          {i > 0 && ', '}
          {fromRule ? <b className={styles.ruleToken}>{token}</b> : token}
        </span>
      ))}
    </p>
  )
}

function Row({ item, form }: { item: PreviewItem; form: DatasetForm }) {
  const t = useT()
  const problem = item.error ?? item.skipped_reason
  return (
    <li className={styles.item} data-testid="preview-item" data-id={item.image_id || undefined} data-path={item.abs_path || undefined}>
      {item.thumbnail_url ? <img src={item.thumbnail_url} alt="" loading="lazy" decoding="async" /> : <span className={styles.thumbGap} />}
      <div>
        <div className={`${styles.itemName} mono`}>{item.filename}</div>
        {item.caption ? <Caption text={item.caption} form={form} /> : <p className={styles.itemError}>{t('dataset.preview.empty')}</p>}
        {problem && <p className={styles.itemError}>{problem}</p>}
      </div>
    </li>
  )
}

/** Every image's caption as the export will write it, with the settings on screen (saved or not). */
export function CaptionPreview({ s }: { s: ReturnType<typeof useDatasetSettings> }) {
  const t = useT()
  const form = s.shown
  const data = s.items
  return (
    <section className={styles.preview} aria-label={t('dataset.preview.title')} data-testid="dataset-caption-preview">
      <header className={styles.previewHead}>
        <h3>{t('dataset.preview.title')}</h3>
        <span className={styles.hint}>
          {s.total > PREVIEW_LIMIT ? t('dataset.preview.countLimited', { n: s.total, shown: PREVIEW_LIMIT }) : t('dataset.preview.count', { n: s.total })}
        </span>
        {s.preview.isFetching && <span className={styles.hint}>{t('dataset.preview.updating')}</span>}
      </header>
      {s.total === 0 ? (
        <p className={styles.previewEmpty}>{t('dataset.preview.noImages')}</p>
      ) : s.preview.isError ? (
        <p className={styles.previewEmpty}>{t('dataset.preview.failed', { reason: s.preview.error.message })}</p>
      ) : !data || !form ? (
        <p className={styles.previewEmpty}>{t('grid.loading')}</p>
      ) : (
        <ol className={styles.previewList}>
          {data.map((item) => (
            <Row key={`${item.image_id}:${item.abs_path}`} item={item} form={form} />
          ))}
        </ol>
      )}
    </section>
  )
}
