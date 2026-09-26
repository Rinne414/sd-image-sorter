import { useT, type MessageKey } from '../../../i18n'
import type { DatasetForm } from '../datasetSettings'
import { tokenBudget } from './captionChecks'
import type { CheckOptions } from './checkOptions'
import styles from './CheckStep.module.css'
import type { SourceState } from './useChecks'

const SOURCE_TEXT: Record<SourceState['id'], MessageKey> = {
  captions: 'dataset.check.source.captions',
  health: 'dataset.check.source.health',
  review: 'dataset.check.source.review',
  audit: 'dataset.check.source.audit',
  aesthetic: 'dataset.check.source.aesthetic',
}

const WARNING_TEXT: Record<NonNullable<SourceState['warning']>, MessageKey> = {
  phashError: 'dataset.check.warn.phashError',
  phashLimited: 'dataset.check.warn.phashLimited',
  healthCut: 'dataset.check.warn.healthCut',
}

/** Sources that read only the Library's own records (folder images are not in them). */
const LIBRARY_ONLY: ReadonlySet<SourceState['id']> = new Set(['health', 'review'])

interface Props {
  sources: readonly SourceState[]
  form: DatasetForm | null
  options: CheckOptions
  onOptions: (o: CheckOptions) => void
  scope: { ids: number[]; paths: string[]; folderCount: number }
  total: number
  onSettings: () => void
}

/** What is checked, over which images, and how each check is doing; the thresholds. */
export function ChecksPanel({ sources, form, options, onOptions, scope, total, onSettings }: Props) {
  const t = useT()
  const purpose = form?.purpose ? t(`dataset.purpose.${form.purpose}` as MessageKey) : t('dataset.check.noPurpose')
  return (
    <section className={styles.block} data-testid="check-sources">
      <h2 className={styles.blockTitle}>{t('dataset.check.whatTitle')}</h2>
      <p className={styles.note}>
        {t('dataset.check.purposeLine', { purpose })}{' '}
        <button type="button" className={styles.link} onClick={onSettings}>
          {t('dataset.check.openSettings')}
        </button>
      </p>
      <ul className={styles.sources}>
        {sources.map((s) => (
          <li key={s.id} className={styles.source} data-status={s.status} data-testid="check-source" data-source={s.id}>
            <span className={styles.sourceName}>{t(SOURCE_TEXT[s.id], { budget: form ? tokenBudget(form.targetModel) : 75 })}</span>
            <span className={styles.sourceState}>
              {s.status === 'na'
                ? t('dataset.check.state.na')
                : s.status === 'checking'
                  ? t('dataset.check.state.checking')
                  : s.status === 'failed'
                    ? t('dataset.check.failed', { reason: s.error ?? '?' })
                    : t('dataset.check.state.done', { n: s.count })}
            </span>
            {s.status === 'failed' && (
              <button type="button" className="btn btn-ghost" onClick={s.retry}>
                {t('dataset.check.retry')}
              </button>
            )}
            {s.warning && <span className={styles.sourceWarn}>{t(WARNING_TEXT[s.warning])}</span>}
            {LIBRARY_ONLY.has(s.id) && scope.folderCount > 0 && s.status !== 'na' && (
              <span className={styles.sourceNa}>{t('dataset.check.notForFolder', { n: scope.folderCount })}</span>
            )}
          </li>
        ))}
      </ul>
      <Thresholds options={options} onOptions={onOptions} folderCount={scope.paths.length} total={total} />
    </section>
  )
}

/** Above this many images the audit compares near duplicates only when asked to (the backend's limit). */
const NEAR_DUPLICATE_LIMIT = 5000

function Thresholds({ options, onOptions, folderCount, total }: { options: CheckOptions; onOptions: (o: CheckOptions) => void; folderCount: number; total: number }) {
  const t = useT()
  const num = (field: 'minSide' | 'minAesthetic' | 'nearDistance', lo: number, hi: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value)
    if (Number.isFinite(v) && v >= lo && v <= hi) onOptions({ ...options, [field]: v })
  }
  return (
    <div className={styles.thresholds}>
      <label className={styles.field}>
        <span>{t('dataset.check.minSide')}</span>
        <input type="number" min={0} max={8192} step={64} value={options.minSide} onChange={num('minSide', 0, 8192)} data-testid="check-min-side" />
      </label>
      <label className={styles.field}>
        <span>{t('dataset.check.minAesthetic')}</span>
        <input type="number" min={0} max={10} step={0.5} value={options.minAesthetic} onChange={num('minAesthetic', 0, 10)} />
      </label>
      <label className={styles.field}>
        <span>{t('dataset.check.nearDistance')}</span>
        <input type="number" min={0} max={64} step={1} value={options.nearDistance} onChange={num('nearDistance', 0, 64)} />
      </label>
      <p className={styles.hint}>{t('dataset.check.thresholdHint')}</p>
      {total > NEAR_DUPLICATE_LIMIT && (
        <label className={styles.check}>
          <input type="checkbox" checked={options.everyPair} onChange={(e) => onOptions({ ...options, everyPair: e.target.checked })} />
          {t('dataset.check.everyPair', { n: total })}
        </label>
      )}
      {folderCount > 0 && (
        <label className={styles.check}>
          <input type="checkbox" checked={options.scoreFolders} onChange={(e) => onOptions({ ...options, scoreFolders: e.target.checked })} />
          {t('dataset.check.scoreFolders', { n: folderCount })}
        </label>
      )}
    </div>
  )
}
