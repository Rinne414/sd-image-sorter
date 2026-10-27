import type { ReactNode } from 'react'
import styles from './SettingRow.module.css'

interface Props {
  title: string
  /** What it does, in one or two lines (a node when it carries a status). */
  body?: ReactNode
  /** The control(s) on the right; they wrap under the words on a narrow window. */
  children?: ReactNode
  testId?: string
}

/** One setting: its name and a line saying what it does on the left, the control on the right. */
export function SettingRow({ title, body, children, testId }: Props) {
  return (
    <div className={styles.row} data-testid={testId}>
      <div className={styles.copy}>
        <strong className={styles.title}>{title}</strong>
        {body !== undefined && <span className={styles.body}>{body}</span>}
      </div>
      {children !== undefined && <div className={styles.control}>{children}</div>}
    </div>
  )
}
