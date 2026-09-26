import { useT, type MessageKey } from '../../i18n'
import styles from './PlannedTool.module.css'

interface Props {
  /** One line: what the page will hold. */
  what: MessageKey
  /** "Still being built; use it in V3.5 for now." */
  note: MessageKey
  testId?: string
}

/**
 * A tool or settings tab not built in V4 yet: what it is for, and that it
 * works in V3.5 today. No controls that would not do anything.
 */
export function PlannedTool({ what, note, testId }: Props) {
  const t = useT()
  return (
    <section className={styles.planned} data-testid={testId}>
      <p className={styles.what}>{t(what)}</p>
      <p className={styles.note}>{t(note)}</p>
      <a className="btn" href="/">
        {t('settings.openV3')}
      </a>
    </section>
  )
}
