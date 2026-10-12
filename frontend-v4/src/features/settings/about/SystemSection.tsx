import { useT } from '../../../i18n'
import styles from './About.module.css'
import { useSystemInfo } from './aboutApi'
import { Section } from './Section'
import { systemFacts } from './systemFacts'

/** This computer: graphics card, VRAM, memory, processor, system. */
export function SystemSection() {
  const t = useT()
  const info = useSystemInfo()
  const probeError = info.data?.error
  const facts = info.data && !probeError ? systemFacts(info.data) : null

  return (
    <Section title={t('about.system.title')} testId="about-system">
      {info.isPending && <p className={styles.hint}>{t('about.system.loading')}</p>}
      {(info.isError || probeError) && (
        <p className={styles.hint}>{t('about.system.failed', { reason: info.error?.message ?? probeError ?? '' })}</p>
      )}
      {facts && (
        <>
          <dl className={styles.facts} data-testid="system-facts">
            <dt>{t('about.system.gpu')}</dt>
            <dd>{facts.gpu ?? '—'}</dd>
            {facts.vram && (
              <>
                <dt>{t('about.system.vram')}</dt>
                <dd>{t('about.system.vramValue', facts.vram)}</dd>
              </>
            )}
            {facts.ram && (
              <>
                <dt>{t('about.system.ram')}</dt>
                <dd>{t('about.system.ramValue', facts.ram)}</dd>
              </>
            )}
            {facts.cpu !== null && (
              <>
                <dt>{t('about.system.cpu')}</dt>
                <dd>{t('about.system.cpuValue', { n: facts.cpu })}</dd>
              </>
            )}
            {facts.os && (
              <>
                <dt>{t('about.system.os')}</dt>
                <dd>{facts.os}</dd>
              </>
            )}
          </dl>
          {!facts.aiGpu && <p className={styles.hint}>{t('about.system.noGpu')}</p>}
        </>
      )}
    </Section>
  )
}
