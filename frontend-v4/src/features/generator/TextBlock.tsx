import { useT } from '../../i18n'
import styles from './Generator.module.css'

interface Props {
  title: string
  lead: string
  text: string
  copyLabel: string
  onCopy: () => void
  testId: string
}

/** One text a generator reads back: what will be copied, shown as it will be, and the button that copies it. */
export function TextBlock({ title, lead, text, copyLabel, onCopy, testId }: Props) {
  const t = useT()
  return (
    <section className={styles.block} aria-label={title} data-testid={testId}>
      <div className={styles.head}>
        <h3 className={styles.title}>{title}</h3>
        <button
          type="button"
          className="btn btn-sm"
          disabled={!text}
          title={text ? undefined : t('generator.noPrompt')}
          onClick={onCopy}
          data-testid={`${testId}-copy`}
        >
          {copyLabel}
        </button>
      </div>
      <p className={styles.lead}>{lead}</p>
      {text ? (
        // Focusable so a long text can be scrolled with the keyboard.
        <pre className={`${styles.preview} mono`} tabIndex={0} aria-label={t('generator.previewLabel')} data-testid={`${testId}-text`}>
          {text}
        </pre>
      ) : (
        <p className={`${styles.preview}`} data-empty="" data-testid={`${testId}-empty`}>
          {t('generator.noPrompt')}
        </p>
      )}
    </section>
  )
}
