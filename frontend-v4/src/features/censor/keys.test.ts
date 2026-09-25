import { describe, expect, it } from 'vitest'
import { keyAction, SHORTCUTS, type KeyPress } from './keys'

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

describe('censor keys', () => {
  it('maps the tool letters, brackets, 0 and the arrows', () => {
    expect(keyAction(press('b'), 'none')).toEqual({ type: 'tool', tool: 'brush' })
    // Caps Lock still picks the tool; Shift+letter does not
    expect(keyAction(press('P'), 'none')).toEqual({ type: 'tool', tool: 'pen' })
    expect(keyAction(press('P', { shiftKey: true }), 'none')).toBeNull()
    expect(keyAction(press('p'), 'none')).toEqual({ type: 'tool', tool: 'pen' })
    expect(keyAction(press('e'), 'none')).toEqual({ type: 'tool', tool: 'eraser' })
    expect(keyAction(press('['), 'none')).toEqual({ type: 'size', delta: -5 })
    expect(keyAction(press(']'), 'none')).toEqual({ type: 'size', delta: 5 })
    expect(keyAction(press('0'), 'none')).toEqual({ type: 'fit' })
    expect(keyAction(press('ArrowLeft'), 'none')).toEqual({ type: 'go', delta: -1 })
    expect(keyAction(press('ArrowRight'), 'none')).toEqual({ type: 'go', delta: 1 })
  })

  it('undo is Ctrl+Z; redo is Ctrl+Shift+Z and Ctrl+Y; Ctrl+S saves', () => {
    expect(keyAction(press('z', { ctrlKey: true }), 'none')).toEqual({ type: 'undo' })
    expect(keyAction(press('Z', { ctrlKey: true, shiftKey: true }), 'none')).toEqual({ type: 'redo' })
    expect(keyAction(press('y', { ctrlKey: true }), 'none')).toEqual({ type: 'redo' })
    expect(keyAction(press('s', { metaKey: true }), 'none')).toEqual({ type: 'save' })
    expect(keyAction(press('z'), 'none')).toBeNull()
    expect(keyAction(press('y'), 'none')).toBeNull()
    expect(keyAction(press('b', { ctrlKey: true }), 'none')).toBeNull()
    expect(keyAction(press('z', { ctrlKey: true, altKey: true }), 'none')).toBeNull()
  })

  it('leaves keys to a text field, except Ctrl+S', () => {
    for (const key of ['b', 'e', '[', ']', '0', 'ArrowLeft']) expect(keyAction(press(key), 'text')).toBeNull()
    expect(keyAction(press('z', { ctrlKey: true }), 'text')).toBeNull()
    expect(keyAction(press('s', { ctrlKey: true }), 'text')).toEqual({ type: 'save' })
  })

  it('D detects anywhere in the editor; the review keys act only in review mode', () => {
    expect(keyAction(press('d'), 'none')).toEqual({ type: 'detect' })
    expect(keyAction(press('D'), 'control')).toEqual({ type: 'detect' })
    expect(keyAction(press('d'), 'text')).toBeNull()
    for (const key of ['1', 'a', 's', 'Enter']) expect(keyAction(press(key), 'none')).toBeNull()
    // outside review R removes the background
    expect(keyAction(press('r'), 'none')).toEqual({ type: 'removeBg' })

    expect(keyAction(press('1'), 'none', true)).toEqual({ type: 'region', n: 1 })
    expect(keyAction(press('9'), 'none', true)).toEqual({ type: 'region', n: 9 })
    expect(keyAction(press('a'), 'none', true)).toEqual({ type: 'allRegions' })
    expect(keyAction(press('Enter'), 'none', true)).toEqual({ type: 'approve' })
    expect(keyAction(press('s'), 'none', true)).toEqual({ type: 'skip' })
    expect(keyAction(press('r'), 'none', true)).toEqual({ type: 'redetect' })
    // 0 still fits, the tools and arrows still work, Ctrl+S still saves
    expect(keyAction(press('0'), 'none', true)).toEqual({ type: 'fit' })
    expect(keyAction(press('e'), 'none', true)).toEqual({ type: 'tool', tool: 'eraser' })
    expect(keyAction(press('ArrowRight'), 'none', true)).toEqual({ type: 'go', delta: 1 })
    expect(keyAction(press('s', { ctrlKey: true }), 'none', true)).toEqual({ type: 'save' })
    // typing in the SAM3 words box never reviews; Enter on a slider does not approve
    for (const key of ['1', 'a', 's', 'r', 'Enter']) expect(keyAction(press(key), 'text', true)).toBeNull()
    expect(keyAction(press('Enter'), 'control', true)).toBeNull()
    expect(keyAction(press('1', { shiftKey: true }), 'none', true)).toBeNull()
  })

  it('G clone, H show changes', () => {
    expect(keyAction(press('g'), 'none')).toEqual({ type: 'tool', tool: 'clone' })
    expect(keyAction(press('h'), 'none', true)).toEqual({ type: 'changes' })
  })

  it('the shortcut list shows exactly the keys that do something', () => {
    const label = (key: string, mods: Partial<KeyPress>) => {
      const named: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→' }
      const base = named[key] ?? (key.length === 1 ? key.toUpperCase() : key)
      return `${mods.ctrlKey ? 'Ctrl+' : ''}${mods.shiftKey ? 'Shift+' : ''}${base}`
    }
    const listed = (text: string, reviewing: boolean) =>
      SHORTCUTS.some(
        (s) =>
          s.when !== 'pointer' &&
          (s.when !== 'review' || reviewing) &&
          (s.when !== 'outside' || !reviewing) &&
          s.keys.some((k) => k === text || (k === '1–9' && /^[1-9]$/.test(text))),
      )
    const keys = [...'abcdefghijklmnopqrstuvwxyz0123456789[]', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'F1', 'F2', 'Delete', 'Escape', ' ']
    const combos: Partial<KeyPress>[] = [{}, { ctrlKey: true }, { ctrlKey: true, shiftKey: true }]
    for (const reviewing of [false, true]) {
      for (const key of keys) {
        for (const mods of combos) {
          const action = keyAction(press(key, mods), 'none', reviewing)
          // Shift is ignored for [ and ], so only the plain form is listed.
          const shown = listed(label(key, mods), reviewing)
          if (action) expect(shown, `${label(key, mods)} (review ${reviewing}) does something but is not listed`).toBe(true)
          else expect(shown, `${label(key, mods)} (review ${reviewing}) is listed but does nothing`).toBe(false)
        }
      }
    }
  })

  it('leaves the arrows to a slider but still takes tool keys there', () => {
    expect(keyAction(press('ArrowRight'), 'control')).toBeNull()
    expect(keyAction(press('ArrowLeft'), 'control')).toBeNull()
    expect(keyAction(press('e'), 'control')).toEqual({ type: 'tool', tool: 'eraser' })
    expect(keyAction(press(']'), 'control')).toEqual({ type: 'size', delta: 5 })
    expect(keyAction(press('z', { ctrlKey: true }), 'control')).toEqual({ type: 'undo' })
  })
})
