import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import styles from './ContextMenu.module.css'
import { Icon } from './Icon'
import { useClickOutside, useLayer } from './layers'

// A menu at the pointer (or at an element, for the keyboard): groups with
// optional headings, one level of submenus. ↑↓ Home End move, → or Enter
// opens a submenu, ← closes it, Esc closes the topmost menu (layer stack),
// Tab or a click outside closes everything. A choice closes the menu first.

export interface CtxItem {
  id: string
  label: string
  hint?: string
  danger?: boolean
  disabled?: boolean
  /** Heading above this item (inside a submenu). */
  group?: string
  children?: CtxItem[]
  onSelect?: () => void
}

export interface CtxGroup {
  heading?: string
  items: CtxItem[]
}

interface Props {
  x: number
  y: number
  label: string
  header?: string
  groups: CtxGroup[]
  onClose: () => void
  /** Opened from the keyboard: focus the first item. */
  focusFirst?: boolean
  testId?: string
}

const EDGE = 8
const ITEM = '[role="menuitem"]:not([disabled])'
const HOVER_CLOSE_MS = 220

/** Keep a box of this size inside the window, preferring below-right of (x, y). */
function place(x: number, y: number, w: number, h: number, flipX = 0): { left: number; top: number } {
  let left = x
  if (left + w > innerWidth - EDGE) left = flipX ? flipX - w : innerWidth - EDGE - w
  const top = Math.min(y, innerHeight - EDGE - h)
  return { left: Math.max(EDGE, left), top: Math.max(EDGE, top) }
}

/** The choosable items of this menu, not of a submenu inside it. */
function items(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return [...root.querySelectorAll<HTMLElement>(ITEM)].filter((el) => el.closest('[role="menu"]') === root)
}

function moveFocus(root: HTMLElement | null, key: string): boolean {
  const list = items(root)
  if (!list.length) return false
  const at = list.indexOf(document.activeElement as HTMLElement)
  let next = at
  if (key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % list.length
  else if (key === 'ArrowUp') next = at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length
  else if (key === 'Home') next = 0
  else if (key === 'End') next = list.length - 1
  else return false
  list[next]?.focus()
  return true
}

export function ContextMenu({ x, y, label, header, groups, onClose, focusFirst = false, testId }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [sub, setSub] = useState<{ item: CtxItem; anchor: DOMRect } | null>(null)
  const closeTimer = useRef<number | undefined>(undefined)
  useLayer(true, onClose)
  useClickOutside(ref, true, onClose)

  // Placed again whenever it changes size (entries arrive once the image's details load).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => setPos(place(x, y, el.offsetWidth, el.offsetHeight))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [x, y])

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    if (focusFirst) items(ref.current)[0]?.focus()
    else ref.current?.focus()
    return () => {
      window.clearTimeout(closeTimer.current)
      if (before?.isConnected) before.focus()
    }
  }, [focusFirst])

  const choose = (item: CtxItem) => {
    onClose()
    item.onSelect?.()
  }

  const openSub = (item: CtxItem, el: HTMLElement, focus: boolean) => {
    window.clearTimeout(closeTimer.current)
    setSub({ item, anchor: el.getBoundingClientRect() })
    if (focus) requestAnimationFrame(() => items(document.querySelector<HTMLElement>('[data-ctx-sub]'))[0]?.focus())
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      onClose()
      return
    }
    const inSub = (e.target as HTMLElement).closest('[data-ctx-sub]')
    if (inSub) return
    if (moveFocus(ref.current, e.key)) {
      e.preventDefault()
      return
    }
    const el = e.target as HTMLElement
    const id = el.dataset.item
    const item = groups.flatMap((g) => g.items).find((i) => i.id === id)
    if (item?.children && (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      openSub(item, el, true)
    }
  }

  return createPortal(
    <div
      ref={ref}
      className={styles.menu}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      data-testid={testId}
    >
      {header && (
        <div className={styles.header} role="presentation" title={header}>
          {header}
        </div>
      )}
      {groups.map((group, gi) => (
        <div key={gi} role="group" aria-label={group.heading} className={styles.group} data-divider={gi > 0 || !!header || undefined}>
          {group.heading && <div className={styles.heading}>{group.heading}</div>}
          {group.items.map((item) => (
            <Row
              key={item.id}
              item={item}
              expanded={sub?.item.id === item.id}
              onChoose={choose}
              onEnter={(el) => {
                if (item.children) openSub(item, el, false)
                else if (sub) closeTimer.current = window.setTimeout(() => setSub(null), HOVER_CLOSE_MS)
              }}
              onOpen={(el) => (sub?.item.id === item.id ? setSub(null) : openSub(item, el, false))}
            />
          ))}
        </div>
      ))}
      {sub && (
        <SubMenu
          parent={sub.item}
          anchor={sub.anchor}
          onChoose={choose}
          onClose={(refocus) => {
            setSub(null)
            if (refocus) ref.current?.querySelector<HTMLElement>(`[data-item="${CSS.escape(sub.item.id)}"]`)?.focus()
          }}
          onHold={() => window.clearTimeout(closeTimer.current)}
        />
      )}
    </div>,
    document.body,
  )
}

function Row({
  item,
  expanded,
  onChoose,
  onEnter,
  onOpen,
}: {
  item: CtxItem
  expanded?: boolean
  onChoose: (item: CtxItem) => void
  onEnter?: (el: HTMLElement) => void
  onOpen?: (el: HTMLElement) => void
}) {
  const parent = !!item.children
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={styles.item}
      data-item={item.id}
      data-danger={item.danger || undefined}
      disabled={item.disabled}
      aria-haspopup={parent ? 'menu' : undefined}
      aria-expanded={parent ? !!expanded : undefined}
      onPointerEnter={(e) => onEnter?.(e.currentTarget)}
      onClick={(e) => (parent ? onOpen?.(e.currentTarget) : onChoose(item))}
    >
      <span className={styles.label}>{item.label}</span>
      {item.hint && <kbd className={styles.hint}>{item.hint}</kbd>}
      {parent && (
        <span className={styles.more} aria-hidden>
          <Icon name="right" size={12} />
        </span>
      )}
    </button>
  )
}

function SubMenu({
  parent,
  anchor,
  onChoose,
  onClose,
  onHold,
}: {
  parent: CtxItem
  anchor: DOMRect
  onChoose: (item: CtxItem) => void
  onClose: (refocus: boolean) => void
  onHold: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: anchor.right, top: anchor.top - 4 })
  // Its own layer: Esc closes the submenu and leaves the menu open.
  useLayer(true, () => onClose(true))

  useLayoutEffect(() => {
    const el = ref.current
    if (el) setPos(place(anchor.right + 2, anchor.top - 4, el.offsetWidth, el.offsetHeight, anchor.left - 2))
  }, [anchor])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (moveFocus(ref.current, e.key)) e.preventDefault()
    else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      onClose(true)
    }
  }

  const children = parent.children ?? []
  const rows: ReactNode[] = []
  children.forEach((item, i) => {
    if (item.group && item.group !== children[i - 1]?.group) {
      rows.push(
        <div key={`h-${item.id}`} className={styles.heading} data-divider={i > 0 || undefined}>
          {item.group}
        </div>,
      )
    }
    rows.push(<Row key={item.id} item={item} onChoose={onChoose} />)
  })

  return (
    <div
      ref={ref}
      className={`${styles.menu} ${styles.sub}`}
      role="menu"
      aria-label={parent.label}
      data-ctx-sub=""
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onKeyDown}
      onPointerEnter={onHold}
    >
      {rows}
    </div>
  )
}
