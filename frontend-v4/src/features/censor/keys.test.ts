import { describe, expect, it } from 'vitest'
import { keyAction, type KeyPress } from './keys'

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

  it('leaves the arrows to a slider but still takes tool keys there', () => {
    expect(keyAction(press('ArrowRight'), 'control')).toBeNull()
    expect(keyAction(press('ArrowLeft'), 'control')).toBeNull()
    expect(keyAction(press('e'), 'control')).toEqual({ type: 'tool', tool: 'eraser' })
    expect(keyAction(press(']'), 'control')).toEqual({ type: 'size', delta: 5 })
    expect(keyAction(press('z', { ctrlKey: true }), 'control')).toEqual({ type: 'undo' })
  })
})
