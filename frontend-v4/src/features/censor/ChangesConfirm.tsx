import { useRef } from 'react'
import { useT } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { useChangesAsk } from './changes'
import { useCensorPanel } from './panel'
import styles from './ToolPanel.module.css'

/** Asks before comparing every pixel of a very large picture ("show changes"). */
export function ChangesConfirm() {
  const t = useT()
  const megapixels = useChangesAsk((s) => s.megapixels)
  const cancelRef = useRef<HTMLButtonElement>(null)
  if (megapixels === null) return null
  const close = () => useChangesAsk.setState({ megapixels: null })
  const yes = () => {
    close()
    useCensorPanel.getState().setShowChanges(true)
  }
  const footer = (
    <>
      <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={close}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn btn-primary" onClick={yes} data-testid="censor-changes-yes">
        {t('censor.changes.go')}
      </button>
    </>
  )
  return (
    <Dialog title={t('censor.changes.toggle')} onClose={close} footer={footer} testId="censor-changes-dialog" initialFocus={cancelRef}>
      <p className={styles.dialogBody}>{t('censor.changes.large', { mp: megapixels })}</p>
    </Dialog>
  )
}
