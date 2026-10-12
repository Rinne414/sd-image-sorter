import type { ReactNode } from 'react'
import { Icon } from './Icon'
import styles from './PageHead.module.css'

interface Props {
  /** "← Back to Library": where the page was opened from. */
  backLabel: string
  onBack: () => void
  title: string
  /** Extra on the right of the title (a tool's own actions). */
  children?: ReactNode
  testId?: string
}

/** The head of a page reached from ⚙ or Tools: back to the page it came from, then its title. */
export function PageHead({ backLabel, onBack, title, children, testId }: Props) {
  return (
    <header className={styles.head}>
      <button type="button" className="btn btn-ghost" onClick={onBack} data-testid={testId}>
        <Icon name="left" size={14} />
        {backLabel}
      </button>
      <span className={styles.rule} aria-hidden />
      <h1 className={styles.title}>{title}</h1>
      {children}
    </header>
  )
}
