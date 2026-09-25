import { useEffect, useState } from 'react'
import type { Batch, BatchProjectView } from '../../../api/types'
import { useT, type MessageKey } from '../../../i18n'
import { Icon } from '../../../ui/Icon'
import { useToasts } from '../../../ui/toasts'
import type { DatasetForm } from '../datasetSettings'
import type { Entry } from '../entries'
import { fetchInitialContent, lockedReason, useFinalCaption, useInitialContent } from './captionApi'
import { CaptionEditor, SaveLine } from './CaptionPanel'
import styles from './CaptionPanel.module.css'
import type { CaptionSession, HeadSnapshot, ItemState } from './captionSession'
import { FinalPreview } from './FinalPreview'
import { HistoryPanel } from './HistoryPanel'
import { loadZhSource, saveZhSource, type ZhSource } from './tagAids'
import { useItemState } from './useCaptionSession'

const ZH_LABEL: Record<ZhSource, MessageKey> = {
  off: 'dataset.edit.zhOff',
  web: 'dataset.edit.zhWeb',
  vlm: 'dataset.edit.zhVlm',
}

interface Props {
  batch: Batch
  view: BatchProjectView
  form: DatasetForm
  entry: Entry
  /** What the server holds for this image (from the batch's heads). */
  head: HeadSnapshot
  headsReady: boolean
  session: CaptionSession
  position: { at: number; of: number }
  onGo: (step: 1 | -1) => void
  vocabulary: readonly string[]
}

/** Load the image into the session: its saved caption, or (never edited) the one it starts from. */
function useOpenItem(p: Props, locked: boolean): { item: ItemState | undefined; failed: string | null } {
  const { batch, form, entry, head, headsReady, session } = p
  const item = useItemState(session, entry.key)
  const needsInitial = headsReady && !head.content && !item && !locked
  const initial = useInitialContent(batch, form, entry, needsInitial)
  useEffect(() => {
    if (!headsReady) return
    if (head.content) session.open(entry.key, head, head.content)
    else if (initial.data) session.open(entry.key, head, initial.data)
    // head is rebuilt every render; its generation and content say when it changed.
  }, [headsReady, head.generation, head.content, initial.data, entry.key, session])
  return { item, failed: initial.isError ? initial.error.message : null }
}

/** The right column: where this image is in the list, the caption editor, the final caption, the history. */
export function EditorColumn(p: Props) {
  const t = useT()
  const { batch, view, form, entry, head, session, position, onGo } = p
  const locked = lockedReason(entry)
  const { item, failed } = useOpenItem(p, locked !== null)
  const [history, setHistory] = useState(false)
  const [zh, setZh] = useState<ZhSource>(loadZhSource)
  const [restarting, setRestarting] = useState(false)
  // The newer of what the session and the batch's heads know (a save updates both, not in the same instant).
  const saved = item && item.head.generation >= head.generation ? item.head : head
  const final = useFinalCaption(batch, view, form, entry, saved, p.headsReady)

  const restart = async () => {
    setRestarting(true)
    try {
      const fresh = await fetchInitialContent(batch.id, form, entry)
      session.edit(entry.key, () => fresh)
    } catch (error) {
      useToasts.getState().push(t('error.generic', { reason: (error as Error).message }), 'error')
    } finally {
      setRestarting(false)
    }
  }

  return (
    <aside className={styles.panel} aria-label={t('dataset.edit.panelTitle')} data-testid="edit-panel" data-key={entry.key}>
      <header className={styles.panelHead}>
        <button type="button" className="btn btn-ghost btn-icon" onClick={() => onGo(-1)} aria-label={t('dataset.edit.prev')} title={t('dataset.edit.prevKeys')} data-testid="edit-prev">
          <Icon name="left" size={14} />
        </button>
        <span className={`${styles.position} mono`} data-testid="edit-position">
          {position.at > 0 ? `${position.at} / ${position.of}` : `– / ${position.of}`}
        </span>
        <button type="button" className="btn btn-ghost btn-icon" onClick={() => onGo(1)} aria-label={t('dataset.edit.next')} title={t('dataset.edit.nextKeys')} data-testid="edit-next">
          <Icon name="right" size={14} />
        </button>
        <span className={styles.gap} />
        <label className={styles.zhPick} title={t('dataset.edit.zhHint')}>
          <span>{t('dataset.edit.zh')}</span>
          <select
            className={styles.select}
            value={zh}
            onChange={(e) => {
              const next = e.target.value as ZhSource
              setZh(next)
              saveZhSource(next)
            }}
            data-testid="edit-zh"
          >
            {(['off', 'web', 'vlm'] as const).map((s) => (
              <option key={s} value={s}>
                {t(ZH_LABEL[s])}
              </option>
            ))}
          </select>
        </label>
      </header>
      {history && item ? (
        <HistoryPanel
          batch={batch}
          view={view}
          subjectId={item.head.subjectId}
          generation={item.head.generation}
          activeId={item.head.revisionId}
          busy={item.status === 'saving'}
          onRestore={(id) => session.restore(entry.key, id)}
          onClose={() => setHistory(false)}
        />
      ) : (
        <div className={styles.panelScroll}>
          {locked && <p className={styles.notice}>{t(locked)}</p>}
          {!item ? (
            locked ? null : <p className={styles.muted}>{failed ? t('dataset.edit.loadFailed', { reason: failed }) : t('grid.loading')}</p>
          ) : (
            <>
              <SaveLine item={item} session={session} entryKey={entry.key} />
              <CaptionEditor form={form} entry={entry} item={item} session={session} locked={locked !== null} zhSource={zh} vocabulary={p.vocabulary} />
              <FinalPreview
                form={form}
                final={final.data}
                failed={final.isError ? final.error.message : null}
                pending={item.status === 'waiting' || item.status === 'saving'}
                fromTemplate={!item.head.content}
              />
              <div className={styles.toolRow}>
                <button type="button" className="btn" onClick={() => setHistory(true)} disabled={item.head.subjectId === null} data-testid="edit-history-open">
                  {t('dataset.history.open')}
                </button>
                {item.head.content && locked === null && (
                  <button type="button" className="btn btn-ghost" onClick={() => void restart()} disabled={restarting} title={t('dataset.edit.restartHint')} data-testid="edit-restart">
                    {t('dataset.edit.restart')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </aside>
  )
}
