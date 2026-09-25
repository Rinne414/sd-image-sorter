import { useRef, useState, type ReactNode } from 'react'
import styles from './Menu.module.css'
import { Icon } from './Icon'
import { useClickOutside, useLayer } from './layers'

export interface MenuItem {
  id: string
  label: string
  checked?: boolean
  hint?: string
  onSelect: () => void
  /** Starts a new group with a divider above it. */
  divider?: boolean
  /** Destructive: shown in the danger colour. */
  danger?: boolean
}

interface Props {
  label: ReactNode
  items: MenuItem[]
  title?: string
  align?: 'left' | 'right'
  /** Open above the button (for bars docked at the bottom of the screen). */
  up?: boolean
}

/** A button that opens a short list. Esc, outside click or a choice closes it. */
export function Menu({ label, items, title, align = 'left', up = false }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useLayer(open, () => setOpen(false))
  useClickOutside(ref, open, () => setOpen(false))

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
          <Icon name="caret" size={13} />
        </span>
      </button>
      {open && (
        <ul className={styles.menu} data-align={align} data-up={up || undefined} role="menu">
          {items.map((item) => (
            <li key={item.id} data-divider={item.divider || undefined} data-danger={item.danger || undefined}>
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
