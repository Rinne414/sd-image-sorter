import type { MessageKey } from '../../i18n'
import type { Tool } from './ops'
import { SIZE_STEP } from './settings'

// The censor editor's keys as a pure mapping, so the rules can be tested:
// letters and brackets never fire while the user types text, arrows never
// while any form control has the focus (a slider uses them itself). The
// review keys (1-9, A, Enter, S, R) exist only in review mode; outside it R
// removes the background. SHORTCUTS below is the list the editor shows; a
// test checks it against keyAction so the two cannot drift apart.

export type KeyAction =
  | { type: 'tool'; tool: Tool }
  | { type: 'size'; delta: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'save' }
  | { type: 'fit' }
  | { type: 'go'; delta: -1 | 1 }
  | { type: 'detect' }
  | { type: 'region'; n: number }
  | { type: 'allRegions' }
  | { type: 'approve' }
  | { type: 'skip' }
  | { type: 'redetect' }
  | { type: 'removeBg' }
  | { type: 'changes' }
  | { type: 'rename' }

export interface KeyPress {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** What has the keyboard focus: a text field, another form control (slider, colour), or neither. */
export type FocusKind = 'text' | 'control' | 'none'

const TEXTLESS_INPUTS = new Set(['range', 'color', 'checkbox', 'radio', 'button', 'submit', 'reset'])

export function focusKind(target: EventTarget | null): FocusKind {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return 'none'
  if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return 'text'
  if (target instanceof HTMLInputElement) return TEXTLESS_INPUTS.has(target.type) ? 'control' : 'text'
  return 'none'
}

const TOOL_KEYS: Record<string, Tool> = { b: 'brush', p: 'pen', e: 'eraser', g: 'clone' }

function withCtrl(key: string, shift: boolean): KeyAction | null {
  if (key === 'z') return shift ? { type: 'redo' } : { type: 'undo' }
  if (key === 'y' && !shift) return { type: 'redo' }
  if (key === 's' && !shift) return { type: 'save' }
  return null
}

const REVIEW_KEYS: Record<string, KeyAction> = { a: { type: 'allRegions' }, s: { type: 'skip' }, r: { type: 'redetect' } }

function reviewKey(key: string, focus: FocusKind): KeyAction | null {
  if (/^[1-9]$/.test(key)) return { type: 'region', n: Number(key) }
  if (key === 'Enter') return focus === 'none' ? { type: 'approve' } : null
  return REVIEW_KEYS[key] ?? null
}

const PLAIN_KEYS: Record<string, KeyAction> = { '0': { type: 'fit' }, d: { type: 'detect' }, h: { type: 'changes' } }

export function keyAction(e: KeyPress, focus: FocusKind, reviewing = false): KeyAction | null {
  if (e.altKey) return null
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (e.ctrlKey || e.metaKey) {
    const action = withCtrl(key, e.shiftKey)
    // While typing, Ctrl+Z belongs to the text field; Ctrl+S never opens the browser's save dialog.
    return focus === 'text' && action?.type !== 'save' ? null : action
  }
  if (focus === 'text') return null
  if (key === '[') return { type: 'size', delta: -SIZE_STEP }
  if (key === ']') return { type: 'size', delta: SIZE_STEP }
  if (e.shiftKey) return null
  if (key === 'F2') return { type: 'rename' }
  const tool = TOOL_KEYS[key]
  if (tool) return { type: 'tool', tool }
  const plain = PLAIN_KEYS[key]
  if (plain) return plain
  const review = reviewing ? reviewKey(key, focus) : null
  if (review) return review
  if (key === 'r' && !reviewing) return { type: 'removeBg' }
  if (focus === 'control') return null
  if (key === 'ArrowLeft') return { type: 'go', delta: -1 }
  if (key === 'ArrowRight') return { type: 'go', delta: 1 }
  return null
}

// ---- the list the editor shows ----

export type ShortcutGroup = 'tools' | 'edit' | 'review' | 'view'

export interface Shortcut {
  /** As shown, e.g. 'Ctrl+Z'; one row may list several. `1–9` is the digit range. */
  keys: string[]
  label: MessageKey
  group: ShortcutGroup
  /** review: only in review mode; outside: only outside it; pointer: a mouse gesture, not a key. */
  when?: 'review' | 'outside' | 'pointer'
}

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: ['B'], label: 'censor.tool.brush', group: 'tools' },
  { keys: ['P'], label: 'censor.tool.pen', group: 'tools' },
  { keys: ['E'], label: 'censor.tool.eraser', group: 'tools' },
  { keys: ['G'], label: 'censor.tool.clone', group: 'tools' },
  { keys: ['Alt+click'], label: 'censor.keys.cloneSource', group: 'tools', when: 'pointer' },
  { keys: ['[', ']'], label: 'censor.size', group: 'tools' },
  { keys: ['Ctrl+Z'], label: 'censor.undo', group: 'edit' },
  { keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], label: 'censor.redo', group: 'edit' },
  { keys: ['Ctrl+S'], label: 'censor.saveNow', group: 'edit' },
  { keys: ['R'], label: 'censor.bg.title', group: 'edit', when: 'outside' },
  { keys: ['F2'], label: 'censor.rename.title', group: 'edit' },
  { keys: ['D'], label: 'censor.detect.this', group: 'review' },
  { keys: ['1–9'], label: 'censor.keys.region', group: 'review', when: 'review' },
  { keys: ['A'], label: 'censor.review.toggleAll', group: 'review', when: 'review' },
  { keys: ['Enter'], label: 'censor.review.approve', group: 'review', when: 'review' },
  { keys: ['S'], label: 'censor.review.skip', group: 'review', when: 'review' },
  { keys: ['R'], label: 'censor.review.redetect', group: 'review', when: 'review' },
  { keys: ['←', '→'], label: 'censor.keys.move', group: 'view' },
  { keys: ['0'], label: 'censor.fit', group: 'view' },
  { keys: ['H'], label: 'censor.changes.toggle', group: 'view' },
  { keys: ['Ctrl+wheel'], label: 'censor.keys.zoom', group: 'view', when: 'pointer' },
  { keys: ['Space+drag'], label: 'censor.keys.pan', group: 'view', when: 'pointer' },
]
