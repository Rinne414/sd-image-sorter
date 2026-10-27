import { describe, expect, it } from 'vitest'
import { acceleratorFrom, DEFAULT_SHORTCUT, displayShortcut, type KeyLike } from './shortcut'

const press = (code: string, key: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })

describe('acceleratorFrom', () => {
  it('writes modifiers in a fixed order', () => {
    expect(acceleratorFrom(press('Space', ' ', { altKey: true, ctrlKey: true }))).toBe('Control+Alt+Space')
    expect(acceleratorFrom(press('KeyK', 'k', { shiftKey: true, ctrlKey: true, metaKey: true }))).toBe('Control+Shift+Super+K')
  })
  it('names letters, digits, function keys and arrows', () => {
    expect(acceleratorFrom(press('Digit7', '7', { ctrlKey: true }))).toBe('Control+7')
    expect(acceleratorFrom(press('F12', 'F12', { altKey: true }))).toBe('Alt+F12')
    expect(acceleratorFrom(press('ArrowLeft', 'ArrowLeft', { ctrlKey: true }))).toBe('Control+Left')
  })
  it('waits while only a modifier is down', () => {
    expect(acceleratorFrom(press('ControlLeft', 'Control', { ctrlKey: true }))).toBeNull()
    expect(acceleratorFrom(press('AltRight', 'Alt', { altKey: true }))).toBeNull()
  })
  it('refuses a key alone and keys it cannot name', () => {
    expect(acceleratorFrom(press('KeyA', 'a'))).toBeNull()
    expect(acceleratorFrom(press('Semicolon', ';', { ctrlKey: true }))).toBeNull()
  })
})

describe('displayShortcut', () => {
  it('reads like the keyboard', () => {
    expect(displayShortcut(DEFAULT_SHORTCUT)).toBe('Ctrl+Alt+Space')
    expect(displayShortcut('Super+Shift+K')).toBe('Win+Shift+K')
    expect(displayShortcut(undefined)).toBe('')
  })
})
