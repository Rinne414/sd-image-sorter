import { useState } from 'react'
import { useT } from '../../i18n'
import { copyText } from '../../lib/format'
import { Icon } from '../../ui/Icon'
import styles from './Card.module.css'

// Pieces every block of the generation card is built from (the card itself and
// the extra information sections in features/info).

export function Section({
  label,
  copy,
  action,
  children,
  testId,
}: {
  label: string
  copy?: string
  action?: React.ReactNode
  children: React.ReactNode
  testId?: string
}) {
  return (
    <section className={styles.section} data-testid={testId}>
      <header className={styles.sectionHead}>
        <span className={styles.label}>{label}</span>
        {action}
        {copy !== undefined && <CopyButton text={copy} compact />}
      </header>
      {children}
    </section>
  )
}

export function CopyButton({ text, label, compact, testId }: { text: string; label?: string; compact?: boolean; testId?: string }) {
  const t = useT()
  const [done, setDone] = useState(false)
  const onClick = async () => {
    if (await copyText(text)) {
      setDone(true)
      window.setTimeout(() => setDone(false), 1200)
    }
  }
  if (compact) {
    return (
      <button type="button" className={styles.copy} onClick={() => void onClick()} title={t('card.copy')} aria-label={t('card.copy')} data-testid={testId}>
        {done ? t('card.copied') : <Icon name="copy" size={14} />}
      </button>
    )
  }
  return (
    <button type="button" className="btn" onClick={() => void onClick()} data-testid={testId}>
      {done ? t('card.copied') : label}
    </button>
  )
}
