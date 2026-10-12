import { useT } from '../../i18n'
import { useApp } from '../../state/store'
import { PageBoundary } from '../../ui/PageBoundary'
import { PageHead } from '../../ui/PageHead'
import styles from './SettingsPage.module.css'
import { SETTINGS_PAGES, settingsTab } from './tabs'
import { useBack } from './useBack'

/**
 * Settings as a page (#/settings/<tab>): the tabs on the left, the open tab on
 * the right. Changes apply at once; Esc only closes things floating above.
 */
export function SettingsPage() {
  const t = useT()
  const current = useApp((s) => s.settingsTab)
  const openSettings = useApp((s) => s.openSettings)
  const back = useBack()
  const tab = settingsTab(current)
  const Page = tab.page

  return (
    <section className={styles.page} data-testid="settings-page">
      <PageHead backLabel={back.label} onBack={back.go} title={t('settings.title')} testId="settings-back" />
      <div className={styles.body}>
        <nav className={styles.tabs} aria-label={t('settings.tabs')}>
          {SETTINGS_PAGES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={styles.tab}
              aria-current={entry.id === current ? 'page' : undefined}
              onClick={() => openSettings(entry.id)}
              data-testid={`settings-tab-${entry.id}`}
            >
              {t(entry.label)}
            </button>
          ))}
        </nav>
        <main className={styles.content} aria-labelledby="settings-tab-title" data-testid={`settings-${current}`}>
          <h2 id="settings-tab-title" className={styles.tabTitle}>
            {t(tab.label)}
          </h2>
          <PageBoundary key={current}>
            <Page />
          </PageBoundary>
        </main>
      </div>
    </section>
  )
}
