import { useEffect, useRef, useState, type ReactNode } from 'react'
import styles from './Menu.module.css'

export interface MenuItem {
  id: string
  label: string
  checked?: boolean
  hint?: string
  onSelect: () => void
  /** Starts a new group with a divider above it. */
  divider?: boolean
}

interface Props {
  label: ReactNode
  items: MenuItem[]
  title?: string
  align?: 'left' | 'right'
}

/** A button that opens a short list. Esc, outside click or a choice closes it. */
export function Menu({ label, items, title, align = 'left' }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className="btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen(!open)}
      >
        {label}
        <span className={styles.caret} aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <ul className={styles.menu} data-align={align} role="menu">
          {items.map((item) => (
            <li key={item.id} data-divider={item.divider || undefined}>
              <button
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={item.checked}
                onClick={() => {
                  item.onSelect()
                  setOpen(false)
                }}
              >
                <span className={styles.check} aria-hidden>
                  {item.checked ? '●' : ''}
                </span>
                <span className={styles.itemLabel}>{item.label}</span>
                {item.hint && <kbd>{item.hint}</kbd>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
