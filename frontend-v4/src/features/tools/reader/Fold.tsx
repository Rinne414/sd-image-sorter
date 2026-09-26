import type { ReactNode } from 'react'
import { create } from 'zustand'
import { Icon } from '../../../ui/Icon'
import styles from './Reader.module.css'

// The Reader's sections fold away with a click on their name, and stay the
// way the user left them (across images and restarts).

const KEY = 'sd-v4-reader-folds'

function load(): Record<string, boolean> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return raw && typeof raw === 'object' ? (raw as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

export const useFolds = create<{ open: Record<string, boolean> }>(() => ({ open: load() }))

export function setFold(id: string, open: boolean): void {
  const next = { ...useFolds.getState().open, [id]: open }
  useFolds.setState({ open: next })
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // storage blocked: the sections stay as they are for this visit
  }
}

export function useFoldOpen(id: string, openByDefault = true): boolean {
  return useFolds((s) => s.open[id] ?? openByDefault)
}

interface Props {
  id: string
  label: string
  /** A count after the name (tags, characters…). */
  count?: number
  /** Buttons on the right of the head (copy, format…). */
  actions?: ReactNode
  openByDefault?: boolean
  children: ReactNode
}

export function Fold({ id, label, count, actions, openByDefault = true, children }: Props) {
  const open = useFoldOpen(id, openByDefault)
  return (
    <section className={styles.fold} data-testid={`reader-${id}`} data-open={open || undefined}>
      <header className={styles.foldHead}>
        <button type="button" className={styles.foldToggle} aria-expanded={open} onClick={() => setFold(id, !open)}>
          <Icon name={open ? 'caret' : 'right'} size={12} className={styles.foldCaret} />
          <span>{label}</span>
          {count !== undefined && <span className="mono">{count}</span>}
        </button>
        {open && actions}
      </header>
      {open && <div className={styles.foldBody}>{children}</div>}
    </section>
  )
}
