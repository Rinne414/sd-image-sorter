import { useRef } from 'react'
import { useT } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { useDownloadAsk } from './detectRun'
import styles from './ToolPanel.module.css'

/** "This needs a model that is not here yet": its name and size; nothing downloads until the user says yes. */
export function DownloadConfirm() {
  const t = useT()
  const ask = useDownloadAsk((s) => s.ask)
  const cancelRef = useRef<HTMLButtonElement>(null)
  if (!ask) return null
  const close = () => useDownloadAsk.setState({ ask: null })
  const yes = () => {
    close()
    ask.yes()
  }

  const footer = (
    <>
      <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={close}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn btn-primary" onClick={yes} data-testid="censor-download-yes">
        {t('censor.ask.yes')}
      </button>
    </>
  )

  return (
    <Dialog title={t('censor.ask.title')} onClose={close} footer={footer} testId="censor-download-dialog" initialFocus={cancelRef}>
      <p className={styles.dialogBody}>{t(ask.purpose)}</p>
      <ul className={styles.dialogList}>
        {ask.models.map((m) => (
          <li key={m.label}>
            <strong>{m.label}</strong>
            <span className="mono">{m.size ? t('censor.ask.size', { size: m.size }) : t('censor.ask.sizeUnknown')}</span>
          </li>
        ))}
      </ul>
      <p className={styles.dialogBody}>{t('censor.ask.after')}</p>
    </Dialog>
  )
}
