import { useState } from 'react'
import { useT } from '../../../i18n'
import { isDebug, setDebug } from '../../../lib/debug'
import { openLog } from '../../import/supportLog'
import { restartApp } from '../restart'
import { useSaved } from '../useSaved'
import styles from './About.module.css'
import { copyAboutDiagnostics, useSystemInfo } from './aboutApi'
import { Section } from './Section'
import { systemFacts } from './systemFacts'
import { readUpdate } from './updateState'
import { useUpdates } from './updateStore'

/** Support: copy diagnostics, open the log folder, the detailed log, and restarting the app (set apart). */
export function SupportSection() {
  const t = useT()
  const info = useSystemInfo()
  const [debug, setDebugShown] = useState(isDebug)
  const [saved, mark] = useSaved<'debug'>()

  const copy = () => {
    const facts = info.data && !info.data.error ? systemFacts(info.data) : null
    void copyAboutDiagnostics(facts, readUpdate(useUpdates.getState().status).kind)
  }

  return (
    <Section title={t('about.support.title')} saved={saved === 'debug'} testId="about-support">
      <p className={styles.hint}>{t('about.support.hint')}</p>
      <div className={styles.row}>
        <button type="button" className="btn" onClick={copy} data-testid="about-copy-diag">
          {t('about.support.copy')}
        </button>
        <button type="button" className="btn" onClick={() => void openLog()} data-testid="about-open-log">
          {t('about.support.openLog')}
        </button>
      </div>
      <div className={styles.option}>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={debug}
            onChange={(e) => {
              setDebug(e.target.checked)
              setDebugShown(e.target.checked)
              mark('debug')
            }}
            data-testid="debug-log"
          />
          {t('about.support.debug')}
        </label>
        <p className={styles.hint}>{t('about.support.debugHint')}</p>
      </div>
      <div className={styles.apart}>
        <button type="button" className="btn" onClick={() => void restartApp()} data-testid="about-restart">
          {t('about.support.restart')}
        </button>
      </div>
    </Section>
  )
}
