import { useState } from 'react'
import type { BatchSummary, CollectionRow } from '../../api/types'
import { useLang, useT } from '../../i18n'
import { useApp } from '../../state/store'
import { batchFromCollection, patchBatch, useBatches, useCollections } from './batchApi'
import { useBatchDialog } from './dialogStore'
import { timeAgo } from './batchLogic'
import styles from './BatchList.module.css'
import { ContactSheet, StepTrack } from './ContactSheet'
import { V35Projects } from './V35Projects'
import { InlineName } from './InlineName'
import { collectionName, kindLabel } from './labels'
import { NewBatchMenu } from './NewBatchMenu'

/** The Batch tab: this library's batches, and its V3.5 dataset projects and collections ready to become batches. */
export function BatchList() {
  const t = useT()
  const [showArchived, setShowArchived] = useState(false)
  const batches = useBatches(showArchived)
  const list = batches.data ?? []
  const active = list.filter((b) => b.archived_at === null)
  const archived = list.filter((b) => b.archived_at !== null)

  return (
    <section className={styles.page} data-testid="batch-list">
      <div className={styles.sheet}>
        <header className={styles.head}>
          <h1 className={styles.title}>{t('batch.list.title')}</h1>
          <span className={styles.count}>{t('batch.list.count', { n: active.length })}</span>
          <span className={styles.gap} />
          <label className={styles.toggle}>
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} data-testid="show-archived" />
            {t('batch.list.showArchived')}
          </label>
          <NewBatchMenu />
        </header>
        <p className={styles.lead}>{t('batch.list.lead')}</p>

        {batches.isError ? (
          <p className={styles.empty}>{t('batch.list.error', { reason: batches.error.message })}</p>
        ) : batches.isSuccess && active.length === 0 ? (
          <p className={styles.empty}>{t('batch.list.empty')}</p>
        ) : (
          <ul className={styles.grid}>
            {active.map((b) => (
              <BatchRow key={b.id} batch={b} />
            ))}
          </ul>
        )}

        {showArchived && archived.length > 0 && (
          <>
            <h2 className={styles.section}>{t('batch.list.archived')}</h2>
            <ul className={styles.grid}>
              {archived.map((b) => (
                <BatchRow key={b.id} batch={b} />
              ))}
            </ul>
          </>
        )}

        <V35Projects showArchived={showArchived} />
        <Collections />
      </div>
    </section>
  )
}

function BatchRow({ batch }: { batch: BatchSummary }) {
  const t = useT()
  const lang = useLang((s) => s.lang)
  const openBatch = useApp((s) => s.openBatch)
  const [renaming, setRenaming] = useState(false)
  const archived = batch.archived_at !== null
  const remove = () => useBatchDialog.getState().show({ type: 'delete', batch })

  const rename = (name: string) => {
    setRenaming(false)
    if (name !== batch.name) void patchBatch(batch.id, { name }, batch.revision)
  }

  return (
    <li className={styles.card} data-archived={archived || undefined} data-orphaned={batch.orphaned || undefined} data-testid="batch-row" data-batch-id={batch.id}>
      <button type="button" className={styles.open} onClick={() => openBatch(batch.id)} aria-label={t('batch.list.openNamed', { name: batch.name })}>
        <ContactSheet ids={batch.cover_image_ids} total={batch.item_count} size="l" />
      </button>
      <div className={styles.info}>
        {renaming ? (
          <InlineName value={batch.name} label={t('batch.rename')} onDone={rename} onCancel={() => setRenaming(false)} />
        ) : (
          <button type="button" className={styles.name} onClick={() => openBatch(batch.id)}>
            {batch.name}
          </button>
        )}
        <span className={styles.meta}>
          <span className={styles.kind}>{kindLabel(batch.kind, t)}</span>
          {batch.orphaned ? (
            <span className={styles.warn} data-testid="batch-orphaned">
              {t('dataset.orphaned')}
            </span>
          ) : (
            <span>{t('rail.images', { n: batch.item_count })}</span>
          )}
          <span>{t('batch.list.updated', { when: timeAgo(batch.updated_at, lang) })}</span>
        </span>
        {!batch.orphaned && <StepTrack steps={batch.steps} current={batch.current_step} />}
      </div>
      <span className={styles.actions}>
        {!batch.orphaned && (
          <>
            <button type="button" className="btn btn-primary" onClick={() => openBatch(batch.id)}>
              {t('batch.open')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setRenaming(true)}>
              {t('batch.rename')}
            </button>
            {batch.kind === 'dataset' && (
              <button type="button" className="btn btn-ghost" onClick={() => useBatchDialog.getState().show({ type: 'copy', batch })} data-testid="batch-copy">
                {t('batch.copy.button')}
              </button>
            )}
            <button type="button" className="btn btn-ghost" onClick={() => void patchBatch(batch.id, { archived: !archived }, batch.revision)}>
              {archived ? t('batch.unarchive') : t('batch.archive')}
            </button>
          </>
        )}
        <span className={styles.gap} />
        <button type="button" className="btn btn-danger" onClick={remove}>
          {t('batch.delete.button')}
        </button>
      </span>
    </li>
  )
}

function Collections() {
  const t = useT()
  const collections = useCollections()
  // Every batch, archived ones too: a collection that already became a batch opens that batch.
  const all = useBatches(true)
  const openBatch = useApp((s) => s.openBatch)
  const [busy, setBusy] = useState<number | null>(null)
  const list = collections.data ?? []
  if (list.length === 0) return null

  const madeFrom = (c: CollectionRow) => (all.data ?? []).find((b) => b.source_collection_id === c.id) ?? null

  const make = async (c: CollectionRow) => {
    setBusy(c.id)
    const batch = await batchFromCollection(c, collectionName(c, t))
    setBusy(null)
    if (batch) openBatch(batch.id)
  }

  return (
    <>
      <h2 className={styles.section}>{t('batch.collections.title')}</h2>
      <p className={styles.lead}>{t('batch.collections.lead')}</p>
      <ul className={styles.rows}>
        {list.map((c) => {
          const made = madeFrom(c)
          return (
            <li key={c.id} className={`${styles.row} ${styles.collection}`} data-testid="collection-row">
              <div className={styles.info}>
                <span className={styles.plainName}>{collectionName(c, t)}</span>
                <span className={styles.meta}>
                  <span>{t('rail.images', { n: c.item_count })}</span>
                  {made && <span data-testid="collection-batch">{t('dataset.collectionMade', { name: made.name })}</span>}
                </span>
              </div>
              <span className={styles.actions}>
                {made ? (
                  <button type="button" className="btn" onClick={() => openBatch(made.id)} data-testid="collection-open-batch">
                    {t('dataset.collectionOpen')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void make(c)}
                    disabled={c.item_count === 0 || busy !== null || !all.isSuccess}
                    title={c.item_count === 0 ? t('batch.collections.emptyHint') : undefined}
                  >
                    {t('batch.collections.open')}
                  </button>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </>
  )
}
