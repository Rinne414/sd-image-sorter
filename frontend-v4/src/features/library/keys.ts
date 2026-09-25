import type { MessageKey } from '../../i18n'

// The library's and the big image's keys as pure mappings, so the rules can
// be tested and the shortcut sheet can be generated from the same table.
// SHORTCUTS below is what the sheet shows; keys.test.ts checks every row
// against libraryKey / lightboxKey / appKey so the two cannot drift apart.
// Whether an action applies (an image inspected, something picked) is the
// caller's business: these only say what a key means.

export interface KeyPress {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export type MoveDir = 'left' | 'right' | 'up' | 'down' | 'first' | 'last'

export type LibraryKey =
  | { type: 'move'; dir: MoveDir }
  | { type: 'open' }
  | { type: 'pick' }
  | { type: 'escape' }
  | { type: 'search' }
  | { type: 'remove' }
  | { type: 'rate'; stars: number }
  | { type: 'favorite' }
  | { type: 'card' }
  | { type: 'pickLoaded' }
  | { type: 'invert' }
  | { type: 'menu' }

export type LightboxKey =
  | { type: 'go'; delta: 1 | -1 }
  | { type: 'first' }
  | { type: 'last' }
  | { type: 'pick' }
  | { type: 'rate'; stars: number }
  | { type: 'favorite' }
  | { type: 'info' }
  | { type: 'zoom' }

const MOVES: Record<string, MoveDir> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'first',
  End: 'last',
}

const LIBRARY_PLAIN: Record<string, LibraryKey> = {
  Enter: { type: 'open' },
  ' ': { type: 'pick' },
  Escape: { type: 'escape' },
  '/': { type: 'search' },
  Delete: { type: 'remove' },
  f: { type: 'favorite' },
  i: { type: 'card' },
}

const isCtrl = (e: KeyPress) => e.ctrlKey || e.metaKey
const letter = (key: string) => (key.length === 1 ? key.toLowerCase() : key)

/** The context-menu key, or Shift+F10 (the same thing on keyboards without one). */
function isMenuKey(e: KeyPress): boolean {
  return e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey && !isCtrl(e))
}

export function libraryKey(e: KeyPress): LibraryKey | null {
  if (e.altKey) return null
  if (isMenuKey(e)) return { type: 'menu' }
  const key = letter(e.key)
  if (isCtrl(e)) {
    if (e.shiftKey) return null
    if (key === 'a') return { type: 'pickLoaded' }
    if (key === 'i') return { type: 'invert' }
    return null
  }
  const dir = MOVES[e.key]
  if (dir) return { type: 'move', dir }
  if (/^[0-5]$/.test(e.key)) return { type: 'rate', stars: Number(e.key) }
  return LIBRARY_PLAIN[key] ?? null
}

const LIGHTBOX_PLAIN: Record<string, LightboxKey> = {
  ArrowRight: { type: 'go', delta: 1 },
  ArrowDown: { type: 'go', delta: 1 },
  ArrowLeft: { type: 'go', delta: -1 },
  ArrowUp: { type: 'go', delta: -1 },
  Home: { type: 'first' },
  End: { type: 'last' },
  ' ': { type: 'pick' },
  f: { type: 'favorite' },
  i: { type: 'info' },
  z: { type: 'zoom' },
}

/** Keys of the big image. Ctrl/Alt combinations are left to the browser (Ctrl+F finds, it does not favourite). */
export function lightboxKey(e: KeyPress): LightboxKey | null {
  if (e.altKey || isCtrl(e)) return null
  if (/^[0-5]$/.test(e.key)) return { type: 'rate', stars: Number(e.key) }
  return LIGHTBOX_PLAIN[letter(e.key)] ?? null
}

/** Keys that work on every page, even while typing. */
export function appKey(e: KeyPress): 'palette' | null {
  return isCtrl(e) && !e.altKey && letter(e.key) === 'k' ? 'palette' : null
}

// ---- the sheet ----

export type ShortcutGroup = 'browse' | 'mark' | 'lightbox' | 'app'

export interface Shortcut {
  /** As printed on the key, e.g. 'Ctrl+A'; one row may list several. `1–5` is the digit range. */
  keys: string[]
  label: MessageKey
  group: ShortcutGroup
  /** pointer: a mouse gesture (translated), not a key. */
  pointer?: boolean
}

export const SHORTCUT_GROUPS: { id: ShortcutGroup; label: MessageKey }[] = [
  { id: 'browse', label: 'lib.keys.group.browse' },
  { id: 'mark', label: 'lib.keys.group.mark' },
  { id: 'lightbox', label: 'lib.keys.group.lightbox' },
  { id: 'app', label: 'lib.keys.group.app' },
]

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: ['←', '→', '↑', '↓'], label: 'lib.keys.move', group: 'browse' },
  { keys: ['Home', 'End'], label: 'lib.keys.firstLast', group: 'browse' },
  { keys: ['Enter'], label: 'lib.keys.open', group: 'browse' },
  { keys: ['doubleClick'], label: 'lib.keys.open', group: 'browse', pointer: true },
  { keys: ['/'], label: 'lib.keys.search', group: 'browse' },
  { keys: ['I'], label: 'lib.keys.card', group: 'browse' },
  { keys: ['drag'], label: 'lib.keys.drag', group: 'browse', pointer: true },
  { keys: ['Space'], label: 'lib.keys.pick', group: 'mark' },
  { keys: ['ctrlClick'], label: 'lib.keys.pickClick', group: 'mark', pointer: true },
  { keys: ['shiftClick'], label: 'lib.keys.pickRange', group: 'mark', pointer: true },
  { keys: ['1–5'], label: 'lib.keys.rate', group: 'mark' },
  { keys: ['0'], label: 'lib.keys.clearRating', group: 'mark' },
  { keys: ['F'], label: 'lib.keys.favorite', group: 'mark' },
  { keys: ['Ctrl+A'], label: 'lib.keys.pickLoaded', group: 'mark' },
  { keys: ['Ctrl+I'], label: 'lib.keys.invert', group: 'mark' },
  { keys: ['Esc'], label: 'lib.keys.clearPicks', group: 'mark' },
  { keys: ['Delete'], label: 'lib.keys.remove', group: 'mark' },
  { keys: ['Shift+F10', 'Menu'], label: 'lib.keys.menu', group: 'mark' },
  { keys: ['rightClick'], label: 'lib.keys.menu', group: 'mark', pointer: true },
  { keys: ['←', '→'], label: 'lib.keys.prevNext', group: 'lightbox' },
  { keys: ['Home', 'End'], label: 'lib.keys.firstLast', group: 'lightbox' },
  { keys: ['Space'], label: 'lib.keys.pick', group: 'lightbox' },
  { keys: ['1–5', '0'], label: 'lib.keys.rate', group: 'lightbox' },
  { keys: ['F'], label: 'lib.keys.favorite', group: 'lightbox' },
  { keys: ['Z'], label: 'lib.keys.zoom', group: 'lightbox' },
  { keys: ['I'], label: 'lib.keys.info', group: 'lightbox' },
  { keys: ['Esc'], label: 'lib.keys.close', group: 'lightbox' },
  { keys: ['Ctrl+K'], label: 'lib.keys.palette', group: 'app' },
  { keys: ['Esc'], label: 'lib.keys.closeTop', group: 'app' },
]

const NAMED: Record<string, string> = {
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  Space: ' ',
  Esc: 'Escape',
  Menu: 'ContextMenu',
}

/** The key presses a printed key stands for ('1–5' is 1 and 5; 'Ctrl+A' is Ctrl with a). */
export function pressesFor(printed: string): KeyPress[] {
  const base = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }
  if (printed === '1–5') return ['1', '5'].map((key) => ({ ...base, key }))
  const parts = printed.split('+')
  const last = parts.pop() ?? ''
  const key = NAMED[last] ?? (last.length === 1 ? last.toLowerCase() : last)
  return [{ ...base, key, ctrlKey: parts.includes('Ctrl'), shiftKey: parts.includes('Shift') }]
}
