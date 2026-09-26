import { useT } from '../../../i18n'
import { rememberRoute, v35Href } from '../../../state/arrival'
import { useApp } from '../../../state/store'
import styles from './About.module.css'
import { useAppStats } from './aboutApi'
import { Section } from './Section'
import { SupportSection } from './SupportSection'
import { SystemSection } from './SystemSection'
import { UpdateSection } from './UpdateSection'
import { webLink } from './updateState'

/** Settings › About & updates: version (and the way back to V3.5), updates, privacy, this computer, support. */
export function AboutTab() {
  return (
    <div className={styles.sections}>
      <VersionSection />
      <UpdateSection />
      <PrivacySection />
      <SystemSection />
      <SupportSection />
    </div>
  )
}

function VersionSection() {
  const t = useT()
  const stats = useAppStats()
  const libraryId = useApp((s) => s.libraryId)
  const version = stats.data?.app_version
  const home = webLink(stats.data?.github_url)
  return (
    <Section title={t('about.version.title')} testId="about-version">
      <p className={styles.version}>
        SD Image Sorter{' '}
        <span className="mono" data-testid="app-version">
          {version ?? (stats.isPending ? t('about.version.loading') : '—')}
        </span>
        <span className={`${styles.badge} mono`}>V4</span>
      </p>
      <p className={styles.hint}>{t('about.version.v4')}</p>
      {/* One line for both links: the update's Install button below stays on a 768 px screen. */}
      <p className={`${styles.hint} ${styles.links}`}>
        <a className={styles.link} href={v35Href(libraryId)} onClick={rememberRoute} data-testid="about-back-v35">
          {t('about.version.backToV35')}
        </a>
        {home && (
          <a className={styles.link} href={home} target="_blank" rel="noopener noreferrer">
            {t('about.version.home')} ↗
          </a>
        )}
      </p>
    </Section>
  )
}

function PrivacySection() {
  const t = useT()
  return (
    <Section title={t('about.privacy.title')} testId="about-privacy">
      <p className={styles.lead}>{t('about.privacy.local')}</p>
      <p className={styles.hint}>{t('about.privacy.cloud')}</p>
    </Section>
  )
}
