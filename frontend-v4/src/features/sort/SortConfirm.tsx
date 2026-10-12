import { useRef, useState, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import styles from './SortPage.module.css'

interface Props {
  title: string
  body: string
  confirmLabel: string
  cancelLabel?: string
  onConfirm: () => Promise<unknown>
  onClose: () => void
  /** More to read under the body (a list). */
  children?: ReactNode
}

/** Dropping a sort's undo history is asked first; the safe choice has the focus. */
export function SortConfirm({ title, body, confirmLabel, cancelLabel, onConfirm, onClose, children }: Props) {
  const t = useT()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    await onConfirm()
    setBusy(false)
    onClose()
  }
  return (
    <Dialog
      title={title}
      onClose={onClose}
      testId="sort-confirm"
      initialFocus={cancelRef}
      footer={
        <>
          <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onClose}>
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void go()} disabled={busy}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className={styles.confirmBody}>{body}</p>
      {children}
    </Dialog>
  )
}
