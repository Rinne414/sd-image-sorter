import type { Tool } from './ops'
import { SIZE_STEP } from './settings'

// The censor editor's keys as a pure mapping, so the rules can be tested:
// letters and brackets never fire while the user types text, arrows never
// while any form control has the focus (a slider uses them itself).

export type KeyAction =
  | { type: 'tool'; tool: Tool }
  | { type: 'size'; delta: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'save' }
  | { type: 'fit' }
  | { type: 'go'; delta: -1 | 1 }

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

const TOOL_KEYS: Record<string, Tool> = { b: 'brush', p: 'pen', e: 'eraser' }

function withCtrl(key: string, shift: boolean): KeyAction | null {
  if (key === 'z') return shift ? { type: 'redo' } : { type: 'undo' }
  if (key === 'y' && !shift) return { type: 'redo' }
  if (key === 's' && !shift) return { type: 'save' }
  return null
}

export function keyAction(e: KeyPress, focus: FocusKind): KeyAction | null {
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
  const tool = TOOL_KEYS[key]
  if (tool) return { type: 'tool', tool }
  if (key === '0') return { type: 'fit' }
  if (focus === 'control') return null
  if (key === 'ArrowLeft') return { type: 'go', delta: -1 }
  if (key === 'ArrowRight') return { type: 'go', delta: 1 }
  return null
}
