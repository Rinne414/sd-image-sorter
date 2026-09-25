import { useRef, useState } from 'react'
import type { Batch, BatchItem } from '../../api/types'
import { useT } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { setOutputName } from '../batch/batchApi'
import { cleanOverride } from '../batch/names'
import styles from './RenameDialog.module.css'

const stemOf = (name: string) => name.replace(/\.[^.]+$/, '')

interface Props {
  batch: Batch
  item: BatchItem
  /** The name the export writes now (from the server), when known. */
  finalName: string | null
  onClose: () => void
}

/** F2: this image's own export name (empty = the Name step's rule decides). Same override as the Name step. */
export function RenameDialog({ batch, item, finalName, onClose }: Props) {
  const t = useT()
  const [name, setName] = useState(item.output_name ?? '')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Through the batch's queue, after any change to it still on its way; a failure is said by a toast and the dialog stays.
  const save = async () => {
    setSaving(true)
    if (await setOutputName(batch.id, item.image_id, cleanOverride(name))) onClose()
    else setSaving(false)
  }

  const footer = (
    <>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving} data-testid="censor-rename-ok">
        {t('censor.rename.ok')}
      </button>
    </>
  )

  return (
    <Dialog title={t('censor.rename.title')} onClose={onClose} footer={footer} testId="censor-rename-dialog" initialFocus={inputRef}>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <p className={styles.line}>
          {t('censor.rename.file')} <span className="mono">{item.filename}</span>
        </p>
        <p className={styles.line}>
          {t('censor.rename.final')} <span className="mono">{finalName ?? t('censor.rename.pending')}</span>
        </p>
        <label className={styles.field}>
          <span>{t('censor.rename.label')}</span>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={finalName && !item.output_name ? stemOf(finalName) : ''}
            spellCheck={false}
            maxLength={200}
            data-testid="censor-rename-input"
          />
        </label>
        <p className={styles.note}>{t('censor.rename.note')}</p>
      </form>
    </Dialog>
  )
}
