import { useT } from '../../../i18n'
import styles from './About.module.css'
import { useAppStats } from './aboutApi'
import { Section } from './Section'
import { SupportSection } from './SupportSection'
import { SystemSection } from './SystemSection'
import { UpdateSection } from './UpdateSection'
import { webLink } from './updateState'

/** Settings › About & updates: version, updates, privacy, this computer, support. */
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
      {home && (
        <p className={styles.hint}>
          <a className={styles.link} href={home} target="_blank" rel="noopener noreferrer">
            {t('about.version.home')} ↗
          </a>
        </p>
      )}
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
