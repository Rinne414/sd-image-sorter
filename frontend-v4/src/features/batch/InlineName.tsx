import { useRef, useState } from 'react'
import styles from './InlineName.module.css'

const NAME_MAX = 200

interface Props {
  value: string
  label: string
  onDone: (name: string) => void
  onCancel: () => void
  large?: boolean
}

/** Rename in place: Enter or leaving the field saves, Esc cancels, an empty name keeps the old one. */
export function InlineName({ value, label, onDone, onCancel, large = false }: Props) {
  const [text, setText] = useState(value)
  // Esc unmounts the field; a blur that follows must not save.
  const cancelled = useRef(false)
  const finish = () => {
    if (cancelled.current) return
    const name = text.trim()
    if (name) onDone(name)
    else onCancel()
  }
  return (
    <input
      className={styles.input}
      data-large={large || undefined}
      autoFocus
      value={text}
      maxLength={NAME_MAX}
      aria-label={label}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setText(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          cancelled.current = true
          onCancel()
        }
      }}
      data-testid="inline-name"
    />
  )
}
