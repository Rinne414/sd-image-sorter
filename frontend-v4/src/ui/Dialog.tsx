import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../i18n'
import styles from './Dialog.module.css'
import { Icon } from './Icon'
import { useLayer } from './layers'

interface Props {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  testId?: string
  /** Focused when the dialog opens; the first focusable element otherwise. */
  initialFocus?: RefObject<HTMLElement | null>
  /** true: room for a table; 'x': room for rows of pictures (a review). */
  wide?: boolean | 'x'
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select, textarea, [href], [tabindex]:not([tabindex="-1"])'

/**
 * A modal over the page. Esc (through the layer stack) and the scrim close it;
 * Tab stays inside; focus goes back where it was when it closes.
 */
export function Dialog({ title, onClose, children, footer, testId, initialFocus, wide = false }: Props) {
  const t = useT()
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  useLayer(true, onClose)

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const target = initialFocus?.current ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)
    target?.focus()
    return () => before?.focus?.()
  }, [initialFocus])

  const trapTab = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !panelRef.current) return
    const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)
    const first = items[0]
    const last = items.at(-1)
    if (!first || !last) return
    if (e.shiftKey && document.activeElement === first) {
      last.focus()
      e.preventDefault()
    } else if (!e.shiftKey && document.activeElement === last) {
      first.focus()
      e.preventDefault()
    }
  }

  return createPortal(
    <div className={styles.scrim} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        className={styles.panel}
        data-wide={wide === 'x' ? 'x' : wide || undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        onKeyDown={trapTab}
      >
        <header className={styles.head}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label={t('common.close')} tabIndex={-1}>
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className={styles.body}>{children}</div>
        {footer && <footer className={styles.foot}>{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}
