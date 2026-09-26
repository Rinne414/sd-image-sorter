import { useId, type ReactNode } from 'react'
import { useT } from '../../../i18n'
import styles from './About.module.css'

/** One part of the About tab: a title (with "已保存" beside it for a moment after a change) and what belongs under it. */
export function Section({ title, saved = false, testId, children }: { title: string; saved?: boolean; testId: string; children: ReactNode }) {
  const t = useT()
  const id = useId()
  return (
    <section className={styles.section} aria-labelledby={id} data-testid={testId}>
      <h3 id={id} className={styles.title}>
        {title}
        <span className={styles.saved} role="status">
          {saved ? t('settings.saved') : ''}
        </span>
      </h3>
      {children}
    </section>
  )
}
