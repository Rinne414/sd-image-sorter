import type { ReactNode } from 'react'
import styles from './StepBar.module.css'

interface Props {
  count: string
  hint?: ReactNode
  children?: ReactNode
  testId?: string
}

/** The strip on top of a step: how many images, what to do here, the step's buttons on the right. */
export function StepBar({ count, hint, children, testId }: Props) {
  return (
    <div className={styles.bar} data-testid={testId}>
      <strong className={styles.count}>{count}</strong>
      {hint && <span className={styles.hint}>{hint}</span>}
      <span className={styles.gap} />
      {children}
    </div>
  )
}
