import { useEffect, useRef } from 'react'
import { isTypingTarget } from '../../../lib/format'
import { useApp } from '../../../state/store'
import { layerCount } from '../../../ui/layers'

export interface EditKeys {
  /** A/D, Ctrl+Enter / Ctrl+Shift+Enter. */
  go: (step: 1 | -1) => void
  /** X: out of the dataset (undoable from the toast). */
  drop: () => void
  /** Ctrl+Z outside a text field: the caption's last change. */
  undo: () => void
}

/**
 * The edit step's keys, only while it is on screen. A, D and X never act
 * while typing; Ctrl+Enter moves on even from inside a text field. Anything
 * floating (a dialog, the history) owns the keyboard.
 */
export function useEditKeys(keys: EditKeys): void {
  const ref = useRef(keys)
  ref.current = keys

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (layerCount() > 0 || useApp.getState().page !== 'batch') return
      const k = ref.current
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key === 'Enter' && !e.altKey) {
        // Heard after the field had the key: a tag typed in the tag field is added to this image before moving on.
        e.preventDefault()
        k.go(e.shiftKey ? -1 : 1)
        return
      }
      if (isTypingTarget(e.target) || e.altKey) return
      if (mod) {
        if (!e.shiftKey && e.key.toLowerCase() === 'z') {
          e.preventDefault()
          k.undo()
        }
        return
      }
      const key = e.key.toLowerCase()
      if (key !== 'a' && key !== 'd' && key !== 'x') return
      e.preventDefault()
      // Held down, A/D keep flipping; X takes one image per press.
      if (key === 'x') {
        if (!e.repeat) k.drop()
      } else k.go(key === 'a' ? -1 : 1)
    }
    // Bubble phase: the focused field (and React's handlers on it) see the key first.
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
