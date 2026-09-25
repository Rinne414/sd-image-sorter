import { useState } from 'react'
import type { UnlinkedDatasetProject } from '../../api/types'
import { useLang, useT } from '../../i18n'
import { useApp } from '../../state/store'
import { timeAgo } from './batchLogic'
import styles from './BatchList.module.css'
import { Covers } from './Covers'
import { openProjectAsBatch, useUnlinkedProjects } from './datasetApi'

/** V3.5's dataset projects that no batch shows yet: opening one makes it a dataset batch (V3.5 keeps it too). */
export function V35Projects({ showArchived }: { showArchived: boolean }) {
  const t = useT()
  const lang = useLang((s) => s.lang)
  const projects = useUnlinkedProjects(showArchived)
  const openBatch = useApp((s) => s.openBatch)
  const [busy, setBusy] = useState<number | null>(null)
  const list = projects.data ?? []
  if (list.length === 0) return null

  const open = async (project: UnlinkedDatasetProject) => {
    setBusy(project.id)
    const batch = await openProjectAsBatch(project)
    setBusy(null)
    if (batch) openBatch(batch.id)
  }

  return (
    <>
      <h2 className={styles.section}>{t('dataset.v35.title')}</h2>
      <p className={styles.lead}>{t('dataset.v35.lead')}</p>
      <ul className={styles.rows}>
        {list.map((p) => (
          <li key={p.id} className={styles.row} data-archived={p.archived_at !== null || undefined} data-testid="v35-project-row" data-project-id={p.id}>
            <button type="button" className={styles.open} onClick={() => void open(p)} disabled={busy !== null} aria-label={t('batch.list.openNamed', { name: p.name })}>
              <Covers ids={p.cover_image_ids} />
            </button>
            <div className={styles.info}>
              <span className={styles.plainName}>{p.name}</span>
              <span className={styles.meta}>
                <span className="mono">{t('rail.images', { n: p.item_count })}</span>
                {p.archived_at !== null && <span>{t('dataset.v35.archived')}</span>}
                <span>{t('batch.list.updated', { when: timeAgo(p.updated_at, lang) })}</span>
              </span>
            </div>
            <span className={styles.actions}>
              <button type="button" className="btn" onClick={() => void open(p)} disabled={busy !== null} data-testid="v35-project-open">
                {t('batch.open')}
              </button>
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}
