import { useState } from 'react'
import type { Batch, BatchProjectView } from '../../../api/types'
import { useT, type MessageKey } from '../../../i18n'
import { useLayer } from '../../../ui/layers'
import { Icon } from '../../../ui/Icon'
import { composeCaption } from './captionContent'
import { useCaptionHistory, type Revision } from './captionApi'
import styles from './CaptionPanel.module.css'

const SOURCE: Record<string, MessageKey> = {
  manual: 'dataset.history.manual',
  restore: 'dataset.history.restore',
  wd14: 'dataset.history.wd14',
  vlm: 'dataset.history.vlm',
  legacy_snapshot: 'dataset.history.legacy',
  metadata: 'dataset.history.metadata',
  translation: 'dataset.history.translation',
  sidecar_import: 'dataset.history.sidecar',
}

const TYPE: Record<string, MessageKey> = {
  booru: 'dataset.edit.typeBooru',
  both: 'dataset.edit.typeBoth',
  nl: 'dataset.edit.typeNl',
}

function when(iso: string): string {
  const date = new Date(iso.includes('T') || iso.endsWith('Z') ? iso : `${iso.replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

interface Props {
  batch: Batch
  view: BatchProjectView
  subjectId: number | null
  generation: number
  activeId: number | null
  busy: boolean
  onRestore: (revisionId: number) => Promise<boolean>
  onClose: () => void
}

/** Every saved version of this image's caption, newest first; any older one can become the current one again. */
export function HistoryPanel({ batch, view, subjectId, generation, activeId, busy, onRestore, onClose }: Props) {
  const t = useT()
  const history = useCaptionHistory(batch, view, subjectId, generation)
  useLayer(true, onClose)
  const revisions = history.data?.pages.flatMap((p) => p.revisions) ?? []

  return (
    <section className={styles.history} aria-label={t('dataset.history.title')} data-testid="edit-history">
      <header className={styles.historyHead}>
        <button type="button" className="btn btn-ghost" onClick={onClose} data-testid="edit-history-close">
          <Icon name="left" size={14} />
          {t('dataset.history.back')}
        </button>
        <span className={styles.label}>{t('dataset.history.title')}</span>
      </header>
      <div className={styles.historyScroll}>
        {subjectId === null ? (
          <p className={styles.muted}>{t('dataset.history.none')}</p>
        ) : history.isError ? (
          <p className={styles.problem}>{t('dataset.history.failed', { reason: history.error.message })}</p>
        ) : !history.data ? (
          <p className={styles.muted}>{t('grid.loading')}</p>
        ) : (
          <ol className={styles.revisions}>
            {revisions.map((r) => (
              <RevisionRow key={r.id} revision={r} active={r.id === activeId} busy={busy} onRestore={onRestore} />
            ))}
          </ol>
        )}
        {history.hasNextPage && (
          <button type="button" className="btn" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>
            {t('dataset.history.more')}
          </button>
        )}
      </div>
    </section>
  )
}

function RevisionRow({ revision, active, busy, onRestore }: { revision: Revision; active: boolean; busy: boolean; onRestore: (id: number) => Promise<boolean> }) {
  const t = useT()
  const [restoring, setRestoring] = useState(false)
  const text = composeCaption(revision.content)
  const source = t(SOURCE[revision.source] ?? 'dataset.history.other')
  const who = revision.model ? `${source} · ${revision.model}` : source
  return (
    <li className={styles.revision} data-active={active || undefined} data-testid="edit-revision" data-revision-id={revision.id}>
      <div className={styles.revisionHead}>
        <span className="mono">{when(revision.created_at)}</span>
        <span>{who}</span>
        <span className={styles.muted}>{t(TYPE[revision.content.caption_type] ?? 'dataset.edit.typeBooru')}</span>
        {active && <span className={styles.current}>{t('dataset.history.current')}</span>}
      </div>
      <p className={styles.revisionText}>{text || t('dataset.preview.empty')}</p>
      {!active && (
        <button
          type="button"
          className="btn"
          disabled={busy || restoring}
          onClick={async () => {
            setRestoring(true)
            await onRestore(revision.id)
            setRestoring(false)
          }}
          data-testid="edit-revision-restore"
        >
          {t('dataset.history.restoreThis')}
        </button>
      )}
    </li>
  )
}
