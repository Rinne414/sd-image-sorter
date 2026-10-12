import { useEffect, useRef, type RefObject } from 'react'

// One stack for everything that floats above the page (menus, the palette,
// the lightbox). Esc closes only the topmost layer; keys meant for the page
// underneath are ignored while any layer is open. One window listener owns
// Esc, so two overlays can never both react to the same key press.

interface Layer {
  close: () => void
}

const stack: Layer[] = []
const listeners = new Set<() => void>()

function notify(): void {
  for (const fn of listeners) fn()
}

/** Register an open layer; returns a function that removes it. */
export function pushLayer(close: () => void): () => void {
  const layer: Layer = { close }
  stack.push(layer)
  notify()
  return () => {
    const i = stack.indexOf(layer)
    if (i >= 0) {
      stack.splice(i, 1)
      notify()
    }
  }
}

export function layerCount(): number {
  return stack.length
}

/** True when `close` belongs to the topmost layer. */
export function isTopLayer(close: () => void): boolean {
  return stack.at(-1)?.close === close
}

/** Close the topmost layer. Returns false when nothing was open. */
export function closeTopLayer(): boolean {
  const top = stack.at(-1)
  if (!top) return false
  top.close()
  return true
}

export function onLayersChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || stack.length === 0) return
      e.preventDefault()
      e.stopImmediatePropagation()
      closeTopLayer()
    },
    true,
  )
}

/**
 * While `open`, this component is a layer. Returns `isTop()` so its own key
 * handling can step aside when something opened above it.
 */
export function useLayer(open: boolean, close: () => void): () => boolean {
  const closeRef = useRef(close)
  closeRef.current = close
  const stable = useRef(() => closeRef.current()).current
  useEffect(() => {
    if (!open) return
    return pushLayer(stable)
  }, [open, stable])
  return () => isTopLayer(stable)
}

/** Close when the pointer goes down outside `ref` while `open`. */
export function useClickOutside(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [open, ref])
}
