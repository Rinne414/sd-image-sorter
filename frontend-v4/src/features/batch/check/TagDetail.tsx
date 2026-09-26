import { useMemo } from 'react'
import { useT } from '../../../i18n'
import { Icon } from '../../../ui/Icon'
import { companions, tagHolders } from './captionChecks'
import { useTagAudit, useTagInfo } from './checkApi'
import styles from './CheckStep.module.css'

export interface TagDetailScope {
  /** The final captions by entry key. */
  finals: ReadonlyMap<string, string>
  /** Tags the batch rules put in every caption (they go with everything). */
  skip: ReadonlySet<string>
  libraryIds: readonly number[]
  folderCount: number
}

/** A share at or above this counts as "nearly always together" (V3.5's concept-bleeding mark). */
const ALWAYS_TOGETHER = 0.8

interface Props {
  tag: string
  scope: TagDetailScope
  onPick: (keys: readonly string[]) => void
  onClose: () => void
}

/** One tag: which captions have it, what rides along with it, what it is, and which taggers said it. */
export function TagDetail({ tag, scope, onPick, onClose }: Props) {
  const t = useT()
  const holders = useMemo(() => tagHolders(scope.finals, tag), [scope.finals, tag])
  const along = useMemo(() => companions(scope.finals, tag, scope.skip), [scope.finals, tag, scope.skip])
  return (
    <section className={styles.tagDetail} aria-label={tag} data-testid="check-tag-detail">
      <header className={styles.tagDetailHead}>
        <strong>{tag}</strong>
        <span className={styles.muted}>{t('dataset.check.tagHolders', { n: holders.length })}</span>
        <span className={styles.gap} />
        {holders.length > 0 && (
          <button type="button" className="btn btn-ghost" onClick={() => onPick(holders)}>
            {t('dataset.check.pick', { n: holders.length })}
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label={t('dataset.check.closeTag')} title={t('dataset.check.closeTag')}>
          <Icon name="close" size={14} />
        </button>
      </header>
      <div className={styles.tagDetailBody}>
        <div>
          <h4 className={styles.miniTitle}>{t('dataset.check.goesWith')}</h4>
          {along.rows.length === 0 ? (
            <p className={styles.muted}>{t('dataset.check.goesWithNone')}</p>
          ) : (
            <ul className={styles.plain}>
              {along.rows.map((row) => (
                <li key={row.tag} data-high={row.ratio >= ALWAYS_TOGETHER || undefined} title={row.ratio >= ALWAYS_TOGETHER ? t('dataset.check.alwaysTogether') : undefined}>
                  {row.tag} <span className="mono">{`${row.count}/${along.carriers} (${Math.round(row.ratio * 100)}%)`}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <TagFacts tag={tag} />
        <ModelAudit tag={tag} ids={scope.libraryIds} folderCount={scope.folderCount} />
      </div>
    </section>
  )
}

function TagFacts({ tag }: { tag: string }) {
  const t = useT()
  const info = useTagInfo(tag)
  const d = info.data
  return (
    <div>
      <h4 className={styles.miniTitle}>{t('dataset.check.tagInfo')}</h4>
      {info.isError ? (
        <p className={styles.muted}>{t('dataset.check.failed', { reason: info.error.message })}</p>
      ) : !d ? (
        <p className={styles.muted}>{t('grid.loading')}</p>
      ) : (
        <ul className={styles.plain}>
          {d.canonical && d.canonical.replace(/_/g, ' ') !== tag && <li>{t('dataset.check.aliasOf', { tag: d.canonical })}</li>}
          <li>
            {d.found_in_vocab ? t('dataset.check.danbooru', { n: d.danbooru_count, category: d.category ?? '?' }) : t('dataset.check.notInVocab')}
          </li>
          <li>{t('dataset.check.libraryCount', { n: d.library_count })}</li>
          {d.aliases.length > 0 && <li>{t('dataset.check.aliases', { list: d.aliases.slice(0, 8).join(', ') })}</li>}
          {d.implies.length > 0 && <li>{t('dataset.check.implies', { list: d.implies.join(', ') })}</li>}
        </ul>
      )}
    </div>
  )
}

function ModelAudit({ tag, ids, folderCount }: { tag: string; ids: readonly number[]; folderCount: number }) {
  const t = useT()
  const audit = useTagAudit(tag, ids)
  const rows = audit.data?.models ?? []
  return (
    <div data-testid="check-tag-audit">
      <h4 className={styles.miniTitle}>{t('dataset.check.whoSaid')}</h4>
      {ids.length === 0 ? (
        <p className={styles.muted}>{t('dataset.check.libraryOnly')}</p>
      ) : audit.isError ? (
        <p className={styles.muted}>{t('dataset.check.failed', { reason: audit.error.message })}</p>
      ) : !audit.data ? (
        <p className={styles.muted}>{t('grid.loading')}</p>
      ) : rows.length === 0 ? (
        <p className={styles.muted}>{t('dataset.check.noScores')}</p>
      ) : (
        <ul className={styles.plain}>
          {rows.map((row) => (
            <li key={row.model}>
              {t('dataset.check.modelRow', { model: row.model, n: row.images, avg: row.avg_score.toFixed(2), max: row.max_score.toFixed(2) })}
            </li>
          ))}
        </ul>
      )}
      {folderCount > 0 && ids.length > 0 && <p className={styles.muted}>{t('dataset.check.notForFolder', { n: folderCount })}</p>}
    </div>
  )
}
