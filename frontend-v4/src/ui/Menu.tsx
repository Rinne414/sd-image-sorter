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
  /** Group heading shown above the first item of each group. */
  group?: string
}

interface Props {
  label: ReactNode
  items: MenuItem[]
  title?: string
  align?: 'left' | 'right'
  /** Open above the button (for bars docked at the bottom of the screen). */
  up?: boolean
  /** The main action of its bar: printed in ink. */
  primary?: boolean
  testId?: string
}

/** A button that opens a short list. Esc, outside click or a choice closes it. */
export function Menu({ label, items, title, align = 'left', up = false, primary = false, testId }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useLayer(open, () => setOpen(false))
  useClickOutside(ref, open, () => setOpen(false))

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={primary ? 'btn btn-primary' : 'btn'}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen(!open)}
        data-testid={testId}
      >
        {label}
        <span className={styles.caret} aria-hidden>
          <Icon name="caret" size={13} />
        </span>
      </button>
      {open && (
        <ul className={styles.menu} data-align={align} data-up={up || undefined} role="menu">
          {items.map((item, i) => (
            <MenuRow key={item.id} item={item} heading={item.group && item.group !== items[i - 1]?.group ? item.group : null} first={i === 0}>
              <button
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={item.checked}
                data-item={item.id}
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
            </MenuRow>
          ))}
        </ul>
      )}
    </div>
  )
}

/** One item, with its group heading above it when a new group starts. */
function MenuRow({ item, heading, first, children }: { item: MenuItem; heading: string | null; first: boolean; children: ReactNode }) {
  return (
    <>
      {heading && (
        <li role="presentation" className={styles.group} data-divider={!first || undefined}>
          {heading}
        </li>
      )}
      <li data-divider={(item.divider && !heading) || undefined} data-danger={item.danger || undefined}>
        {children}
      </li>
    </>
  )
}
