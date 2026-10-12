import { describe, expect, it } from 'vitest'
import { appKey, libraryKey, lightboxKey, pressesFor, SHORTCUT_GROUPS, SHORTCUTS, type KeyPress } from './keys'

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

describe('library keys', () => {
  it('arrows, Home and End move; Enter opens; Space picks', () => {
    expect(libraryKey(press('ArrowLeft'))).toEqual({ type: 'move', dir: 'left' })
    expect(libraryKey(press('ArrowDown'))).toEqual({ type: 'move', dir: 'down' })
    expect(libraryKey(press('Home'))).toEqual({ type: 'move', dir: 'first' })
    expect(libraryKey(press('End'))).toEqual({ type: 'move', dir: 'last' })
    expect(libraryKey(press('Enter'))).toEqual({ type: 'open' })
    expect(libraryKey(press(' '))).toEqual({ type: 'pick' })
  })

  it('0–5 rate, F favourites, I toggles the card, / searches, Delete removes, Esc is Esc', () => {
    expect(libraryKey(press('0'))).toEqual({ type: 'rate', stars: 0 })
    expect(libraryKey(press('5'))).toEqual({ type: 'rate', stars: 5 })
    expect(libraryKey(press('6'))).toBeNull()
    expect(libraryKey(press('f'))).toEqual({ type: 'favorite' })
    // Caps Lock still favourites
    expect(libraryKey(press('F'))).toEqual({ type: 'favorite' })
    expect(libraryKey(press('i'))).toEqual({ type: 'card' })
    expect(libraryKey(press('/'))).toEqual({ type: 'search' })
    expect(libraryKey(press('Delete'))).toEqual({ type: 'remove' })
    expect(libraryKey(press('Escape'))).toEqual({ type: 'escape' })
  })

  it('Ctrl+A picks what is loaded, Ctrl+I inverts; other Ctrl and Alt combinations stay with the browser', () => {
    expect(libraryKey(press('a', { ctrlKey: true }))).toEqual({ type: 'pickLoaded' })
    expect(libraryKey(press('A', { metaKey: true }))).toEqual({ type: 'pickLoaded' })
    expect(libraryKey(press('i', { ctrlKey: true }))).toEqual({ type: 'invert' })
    expect(libraryKey(press('f', { ctrlKey: true }))).toBeNull()
    expect(libraryKey(press('1', { ctrlKey: true }))).toBeNull()
    expect(libraryKey(press('ArrowLeft', { ctrlKey: true }))).toBeNull()
    expect(libraryKey(press('i', { ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(libraryKey(press('f', { altKey: true }))).toBeNull()
  })

  it('the menu key and Shift+F10 open the image menu; plain F10 does not', () => {
    expect(libraryKey(press('ContextMenu'))).toEqual({ type: 'menu' })
    expect(libraryKey(press('F10', { shiftKey: true }))).toEqual({ type: 'menu' })
    expect(libraryKey(press('F10'))).toBeNull()
  })
})

describe('big image keys', () => {
  it('arrows step, Home/End jump, Space picks, digits rate, F I Z act', () => {
    expect(lightboxKey(press('ArrowRight'))).toEqual({ type: 'go', delta: 1 })
    expect(lightboxKey(press('ArrowDown'))).toEqual({ type: 'go', delta: 1 })
    expect(lightboxKey(press('ArrowLeft'))).toEqual({ type: 'go', delta: -1 })
    expect(lightboxKey(press('Home'))).toEqual({ type: 'first' })
    expect(lightboxKey(press('End'))).toEqual({ type: 'last' })
    expect(lightboxKey(press(' '))).toEqual({ type: 'pick' })
    expect(lightboxKey(press('3'))).toEqual({ type: 'rate', stars: 3 })
    expect(lightboxKey(press('F'))).toEqual({ type: 'favorite' })
    expect(lightboxKey(press('i'))).toEqual({ type: 'info' })
    expect(lightboxKey(press('Z'))).toEqual({ type: 'zoom' })
  })

  it('Ctrl+F finds in the page instead of favouriting', () => {
    expect(lightboxKey(press('f', { ctrlKey: true }))).toBeNull()
    expect(lightboxKey(press('3', { metaKey: true }))).toBeNull()
  })
})

describe('Ctrl K', () => {
  it('opens the palette with Ctrl or Cmd, in either case', () => {
    expect(appKey(press('k', { ctrlKey: true }))).toBe('palette')
    expect(appKey(press('K', { metaKey: true, shiftKey: true }))).toBe('palette')
    expect(appKey(press('k'))).toBeNull()
    expect(appKey(press('k', { ctrlKey: true, altKey: true }))).toBeNull()
  })
})

describe('the shortcut sheet', () => {
  it('every key row does what the sheet says: the list is the key map', () => {
    for (const row of SHORTCUTS) {
      if (row.pointer) continue
      for (const printed of row.keys) {
        for (const p of pressesFor(printed)) {
          const hit =
            row.group === 'lightbox'
              ? lightboxKey(p) !== null || p.key === 'Escape'
              : row.group === 'app'
                ? appKey(p) !== null || p.key === 'Escape'
                : libraryKey(p) !== null
          expect(hit, `${row.group}: ${printed} (${row.label})`).toBe(true)
        }
      }
    }
  })

  it('lists the keys people asked about, in groups the sheet shows', () => {
    const printed = new Set(SHORTCUTS.flatMap((s) => s.keys))
    for (const key of ['←', 'Enter', 'Space', '1–5', '0', 'F', 'I', 'Z', '/', 'Ctrl+A', 'Ctrl+I', 'Ctrl+K', 'Esc', 'Delete', 'Shift+F10']) {
      expect(printed.has(key), key).toBe(true)
    }
    const groups = new Set(SHORTCUT_GROUPS.map((g) => g.id))
    for (const row of SHORTCUTS) expect(groups.has(row.group)).toBe(true)
  })

  it('reads printed keys back as presses', () => {
    expect(pressesFor('Ctrl+A')).toEqual([{ key: 'a', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }])
    expect(pressesFor('Shift+F10')[0]).toMatchObject({ key: 'F10', shiftKey: true })
    expect(pressesFor('1–5').map((p) => p.key)).toEqual(['1', '5'])
    expect(pressesFor('Space')[0]?.key).toBe(' ')
  })
})
