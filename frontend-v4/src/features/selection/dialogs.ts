import { create } from 'zustand'
import { useApp } from '../../state/store'

// Which selection dialog is open. The selection bar, the Delete key and the
// command palette all open the same dialogs through here. The picks are
// copied when the dialog opens, so a refresh underneath cannot change what
// the confirmed action applies to.

export type SelectionDialog =
  | 'move'
  | 'copy'
  | 'remove'
  | 'trash'
  | 'tag'
  | 'describe'
  | 'edit-tags'
  | 'export'
  | 'missing'
  | 'import'
  | 'libraries'
  | 'new-library'
  | 'move-library'

interface DialogState {
  open: SelectionDialog | null
  /** null: the dialog works on a set the backend picks (e.g. every untagged image). */
  ids: number[] | null
  count: number
  /** Where a folder dialog should open (a dropped folder), if anywhere in particular. */
  hint: string | null
  show: (dialog: SelectionDialog) => void
  /** Open for a set other than the picks. */
  showFor: (dialog: SelectionDialog, ids: number[] | null, count: number, hint?: string) => void
  close: () => void
}

export const useSelectionDialog = create<DialogState>((set) => ({
  open: null,
  ids: [],
  count: 0,
  hint: null,
  show: (dialog) => {
    const ids = useApp.getState().selection
    if (ids.length === 0) return
    set({ open: dialog, ids: [...ids], count: ids.length, hint: null })
  },
  showFor: (dialog, ids, count, hint) => set({ open: dialog, ids: ids ? [...ids] : null, count, hint: hint ?? null }),
  close: () => set({ open: null, ids: [], count: 0, hint: null }),
}))

const RECENT_KEY = 'sd-v4-recent-destinations'
const RECENT_MAX = 8

export function recentDestinations(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string' && p.length > 0) : []
  } catch {
    return []
  }
}

export function rememberDestination(path: string): void {
  const next = [path, ...recentDestinations().filter((p) => p !== path)].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // storage blocked: the list just won't be remembered
  }
}
