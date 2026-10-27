import { useState } from 'react'
import { useT } from '../../../i18n'
import { Section } from '../about/Section'
import { SettingRow } from '../SettingRow'
import { browserEnv, hardRefresh } from './hardRefresh'

/** Settings › About › Hard refresh the interface: caches cleared, page loaded again, everything the user made stays. */
export function RefreshSection() {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const go = () => {
    setBusy(true)
    void hardRefresh(browserEnv())
  }
  return (
    <Section title={t('desktop.refresh.title')} testId="hard-refresh">
      <SettingRow title={t('desktop.refresh.action')} body={t('desktop.refresh.body')}>
        <button type="button" className="btn" disabled={busy} onClick={go} data-testid="hard-refresh-button">
          {busy ? t('desktop.refresh.working') : t('desktop.refresh.action')}
        </button>
      </SettingRow>
    </Section>
  )
}
