import { useT, type MessageKey } from '../i18n'
import styles from './PlannedPage.module.css'

interface Props {
  title: MessageKey
  body: MessageKey
}

/** An honest placeholder: says what the page will be, and where to do it today. */
export function PlannedPage({ title, body }: Props) {
  const t = useT()
  return (
    <section className={styles.page}>
      <div className={styles.sheet}>
        <span className={`${styles.kicker} mono`}>V4</span>
        <h1 className={styles.title}>{t(title)}</h1>
        <p className={styles.body}>{t(body)}</p>
        <p className={styles.note}>{t('planned.note')}</p>
        <a className="btn" href="/">
          {t('planned.openV3')}
        </a>
      </div>
    </section>
  )
}
