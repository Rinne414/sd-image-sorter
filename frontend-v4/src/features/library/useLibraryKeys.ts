import { useEffect, useRef, type RefObject } from 'react'
import type { ImageSummary } from '../../api/types'
import { isTypingTarget } from '../../lib/format'
import type { ImageQueryParams } from '../../lib/searchQuery'
import { useApp } from '../../state/store'
import { layerCount } from '../../ui/layers'
import { useSelectionDialog } from '../selection/dialogs'
import { invertPicks } from '../selection/invert'
import { useSimilar } from '../similar/similarStore'
import { showCardMenuAtTile, useCardMenu } from './CardMenu'
import type { GalleryHandle } from './Gallery'
import { libraryKey, type LibraryKey } from './keys'

interface Deps {
  images: ImageSummary[]
  /** null while the grid is ranked by likeness: there is no filter to invert within. */
  params: ImageQueryParams | null
  gallery: RefObject<GalleryHandle | null>
  search: RefObject<HTMLInputElement | null>
  rate: (id: number, stars: number) => void
  toggleFavorite: (id: number) => void
}

/** Do what a library key means; false when it does not apply now (the browser keeps the key). */
function run(action: LibraryKey, d: Deps): boolean {
  const s = useApp.getState()
  const id = s.inspectedId
  switch (action.type) {
    case 'move':
      d.gallery.current?.move(action.dir)
      return true
    case 'open':
      if (id !== null) s.openLightbox(id)
      return true
    case 'pick':
      if (id !== null) s.togglePick(id)
      return true
    case 'escape':
      if (s.selection.length) s.clearSelection()
      else if (useSimilar.getState().query) useSimilar.getState().clear()
      else return false
      return true
    case 'search':
      d.search.current?.focus()
      return true
    case 'remove':
      if (!s.selection.length) return false
      useSelectionDialog.getState().show('remove')
      return true
    case 'card':
      s.toggleCard()
      return true
    case 'pickLoaded':
      s.setSelection(d.images.map((img) => img.id))
      return true
    case 'invert':
      if (!d.params) return false
      void invertPicks(d.params)
      return true
    case 'rate':
      if (id !== null) d.rate(id, action.stars)
      return id !== null
    case 'favorite':
      if (id !== null) d.toggleFavorite(id)
      return id !== null
    case 'menu':
      if (id !== null) showCardMenuAtTile(id)
      return id !== null
  }
}

const CONTROL = 'button, a[href], summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="switch"], [role="radio"]'

/**
 * A control the keyboard moved to (Tab, the skip link): Enter and Space press
 * it. Focus a mouse click left on a button (a rail row, a card button) does
 * not count, so there Enter still opens the inspected image and Space picks
 * it. (:focus-visible cannot tell: a keydown turns it on for the focused
 * element before this handler runs.)
 */
function pressesControl(action: LibraryKey, target: EventTarget | null, keyboardFocused: EventTarget | null): boolean {
  if (action.type !== 'open' && action.type !== 'pick') return false
  return target instanceof HTMLElement && target === keyboardFocused && target.matches(CONTROL)
}

/** The library's keys (keys.ts). The lightbox, the palette and menus take over while open. */
export function useLibraryKeys(deps: Deps): void {
  const ref = useRef(deps)
  ref.current = deps

  useEffect(() => {
    let lastInput: 'key' | 'pointer' = 'pointer'
    let keyboardFocused: EventTarget | null = null
    const onAnyKey = () => {
      lastInput = 'key'
    }
    const onPointer = () => {
      lastInput = 'pointer'
    }
    const onFocus = (e: FocusEvent) => {
      keyboardFocused = lastInput === 'key' ? e.target : null
    }
    const onKey = (e: KeyboardEvent) => {
      // Anything floating (lightbox, palette, a menu) owns the keyboard.
      if (layerCount() > 0 || useApp.getState().page !== 'library') return
      if (isTypingTarget(e.target)) return
      const action = libraryKey(e)
      if (action && !pressesControl(action, e.target, keyboardFocused) && run(action, ref.current)) e.preventDefault()
    }
    // The menu key also fires the browser's own menu; ours is already open.
    const onContextMenu = (e: MouseEvent) => {
      if (useCardMenu.getState().open) e.preventDefault()
    }
    window.addEventListener('keydown', onAnyKey, true)
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('focusin', onFocus, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('contextmenu', onContextMenu)
    return () => {
      window.removeEventListener('keydown', onAnyKey, true)
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('focusin', onFocus, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('contextmenu', onContextMenu)
    }
  }, [])
}
