import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
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
  /** Class for the item's row, e.g. to show it only when its bar is narrow. */
  className?: string
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
  /** The page on screen belongs to this menu (the top bar's Tools on a tool's page). */
  current?: boolean
  testId?: string
}

const ITEM = '[role="menuitem"], [role="menuitemcheckbox"]'

/** Move the focus among the items: ↑↓ wrap around, Home and End go to the ends. */
function moveFocus(list: HTMLElement | null, key: string): boolean {
  const items = list ? [...list.querySelectorAll<HTMLElement>(ITEM)] : []
  if (!items.length) return false
  const at = items.indexOf(document.activeElement as HTMLElement)
  const next: Record<string, number> = {
    ArrowDown: at < 0 ? 0 : (at + 1) % items.length,
    ArrowUp: at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length,
    Home: 0,
    End: items.length - 1,
  }
  const to = next[key]
  if (to === undefined) return false
  items[to]?.focus()
  return true
}

/**
 * A button that opens a short list. Esc, outside click or a choice closes it.
 * From the keyboard (Enter, Space or ↓ on the button) the first item takes
 * the focus, ↑↓ Home End move, and closing gives the focus back to the button.
 */
export function Menu({ label, items, title, align = 'left', up = false, primary = false, current = false, testId }: Props) {
  const [open, setOpen] = useState(false)
  const [byKeyboard, setByKeyboard] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const close = () => {
    // Opened from the keyboard: the focus goes back to the button instead of being lost.
    // (After a click it is left alone, so Space and the page's keys act on the page.)
    if (byKeyboard && listRef.current?.contains(document.activeElement)) buttonRef.current?.focus()
    setOpen(false)
  }

  useLayer(open, close)
  useClickOutside(ref, open, () => setOpen(false))

  useEffect(() => {
    if (open && byKeyboard) moveFocus(listRef.current, 'Home')
  }, [open, byKeyboard])

  const show = (keyboard: boolean) => {
    setByKeyboard(keyboard)
    setOpen(true)
  }

  const onListKey = (e: KeyboardEvent) => {
    if (moveFocus(listRef.current, e.key)) e.preventDefault()
    else if (e.key === 'Tab') setOpen(false)
  }

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className={primary ? 'btn btn-primary' : 'btn'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={current ? 'page' : undefined}
        title={title}
        // detail 0: pressed with Enter or Space rather than clicked
        onClick={(e) => (open ? setOpen(false) : show(e.detail === 0))}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' || open) return
          e.preventDefault()
          show(true)
        }}
        data-testid={testId}
      >
        {label}
        <span className={styles.caret} aria-hidden>
          <Icon name="caret" size={13} />
        </span>
      </button>
      {open && (
        <ul ref={listRef} className={styles.menu} data-align={align} data-up={up || undefined} role="menu" onKeyDown={onListKey}>
          {items.map((item, i) => (
            <MenuRow key={item.id} item={item} heading={item.group && item.group !== items[i - 1]?.group ? item.group : null} first={i === 0}>
              <button
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={item.checked}
                data-item={item.id}
                onClick={() => {
                  close()
                  item.onSelect()
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
      <li className={item.className} data-divider={(item.divider && !heading) || undefined} data-danger={item.danger || undefined}>
        {children}
      </li>
    </>
  )
}
