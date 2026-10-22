import { useRef, useState } from 'react'
import { useT } from '../../i18n'
import { resetAllSettings } from '../../lib/resetSettings'
import { Dialog } from '../../ui/Dialog'
import styles from './AppearanceTab.module.css'

/**
 * Settings › Appearance, at the end: every preference back to its default in
 * one step (docs/DESIGN.md §redesign-2026-10). Asks first, with Cancel
 * focused, saying what goes back and what stays; then reloads so every page
 * starts from the defaults.
 */
export function ResetAllSection() {
  const t = useT()
  const [asking, setAsking] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)

  const reset = () => {
    try {
      resetAllSettings(localStorage)
    } catch {
      // storage blocked: nothing was kept, so there is nothing to reset
    }
    location.reload()
  }

  return (
    <section className={styles.section} data-testid="reset-all">
      <h3 className={styles.title}>{t('next.reset.title')}</h3>
      <p className={styles.hint}>{t('next.reset.lead')}</p>
      <div>
        <button type="button" className="btn" onClick={() => setAsking(true)} data-testid="reset-all-open">
          {t('next.reset.button')}
        </button>
      </div>
      {asking && (
        <Dialog
          title={t('next.reset.dialogTitle')}
          onClose={() => setAsking(false)}
          initialFocus={cancelRef}
          testId="reset-all-dialog"
          footer={
            <>
              <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={() => setAsking(false)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn btn-danger" onClick={reset} data-testid="reset-all-ok">
                {t('next.reset.ok')}
              </button>
            </>
          }
        >
          <p>{t('next.reset.resets')}</p>
          <p>{t('next.reset.keeps')}</p>
        </Dialog>
      )}
    </section>
  )
}
