// The global shortcut of the desktop program, as the shell wants it
// (Electron accelerator text) and as the user reads it.

export const DEFAULT_SHORTCUT = 'Control+Alt+Space'

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS'])

const CODE_NAMES: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
}

/** The parts of a key event this needs (a real KeyboardEvent fits). */
export interface KeyLike {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** "Control+Alt+Space" as the user reads it: "Ctrl+Alt+Space". */
export function displayShortcut(accelerator: string | null | undefined): string {
  return String(accelerator ?? '')
    .replace(/Control/g, 'Ctrl')
    .replace(/Super/g, 'Win')
}

function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return CODE_NAMES[code] ?? null
}

/** A pressed combination as an accelerator; null while only modifiers are down, for an unusable key, or with no modifier at all. */
export function acceleratorFrom(event: KeyLike): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null
  const key = keyName(event.code)
  if (!key) return null
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Control')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Super')
  if (parts.length === 0) return null
  return [...parts, key].join('+')
}
