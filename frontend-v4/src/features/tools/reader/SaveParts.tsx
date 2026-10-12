import { useT } from '../../../i18n'
import { Dialog } from '../../../ui/Dialog'
import { useTT } from '../toolText'
import styles from './Reader.module.css'
import type { SaveFormat } from './metadataForm'
import type { SaveMessage, Saved } from './saveFlows'

/** Where the last save went, and what the backend warned about it. */
export function SaveResult({ saved }: { saved: Saved }) {
  const t = useTT()
  const say = (m: SaveMessage) => ('text' in m ? m.text : t(m.key, m.params))
  return (
    <div className={styles.saved} data-testid="reader-saved">
      <p className={styles.savedPath}>
        {t(saved.overwrote ? 'reader.edit.overwroteAt' : 'reader.edit.savedAt')} <span className="mono">{saved.path}</span>
      </p>
      {saved.messages.length > 0 && (
        <ul className={styles.notes} data-testid="reader-save-notes">
          {saved.messages.map((m, i) => (
            <li key={i}>{say(m)}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** A file of that name is already there: replace it? (A copy cannot be undone.) */
export function ReplaceDialog({ path, onCancel, onConfirm }: { path: string; onCancel: () => void; onConfirm: () => void }) {
  const t = useTT()
  const common = useT()
  return (
    <Dialog
      title={t('reader.edit.replaceTitle')}
      onClose={onCancel}
      testId="reader-replace-dialog"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            {common('common.cancel')}
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} data-testid="reader-replace-confirm">
            {t('reader.edit.replace')}
          </button>
        </>
      }
    >
      <p className={styles.dialogText}>
        <span className="mono">{path}</span>
      </p>
      <p className={styles.dialogText}>{t('reader.edit.replaceBody')}</p>
    </Dialog>
  )
}

/** Writing into the library image's own file: what changes, what is lost, and the one undo. */
export function OverwriteDialog({
  name,
  format,
  changed,
  onCancel,
  onConfirm,
}: {
  name: string
  format: SaveFormat | null
  changed: number
  onCancel: () => void
  onConfirm: () => void
}) {
  const t = useTT()
  const common = useT()
  return (
    <Dialog
      title={t('reader.edit.overwriteTitle')}
      onClose={onCancel}
      testId="reader-overwrite-dialog"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            {common('common.cancel')}
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} data-testid="reader-overwrite-confirm">
            {t('reader.edit.overwriteConfirm')}
          </button>
        </>
      }
    >
      <p className={styles.dialogText}>{t('reader.edit.overwriteBody', { name, n: changed })}</p>
      {format && format !== 'png' && <p className={styles.warnText}>{t('reader.edit.overwriteReencode', { format: format.toUpperCase() })}</p>}
      <p className={styles.dialogText}>{t('reader.edit.overwriteDrops')}</p>
      <p className={styles.dialogText}>{t('reader.edit.overwriteUndo')}</p>
    </Dialog>
  )
}
