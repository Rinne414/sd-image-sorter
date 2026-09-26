import { useEffect, useRef } from 'react'
import { isTypingTarget } from '../../lib/format'
import { useApp } from '../../state/store'
import { layerCount } from '../../ui/layers'
import { keyAction } from './sortModes'
import { useSortPrefs } from './sortPrefs'
import type { SortMode } from './sortSession'
import { useSort } from './sortStore'

/**
 * The sorting keys of `mode` while a sort is on screen, plus I for the
 * information column. Never while typing, while a dialog or menu floats above
 * the page, or on another page. Focus mode is itself a layer: `focusIsTop`
 * says whether nothing has opened above it. A held key repeats only as fast
 * as the backend answers, so letting go never leaves a backlog behind.
 */
export function useSortKeys(mode: SortMode, focusIsTop: (() => boolean) | null = null): void {
  const modeRef = useRef(mode)
  const topRef = useRef(focusIsTop)
  modeRef.current = mode
  topRef.current = focusIsTop
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useApp.getState().page !== 'sort' || e.isComposing || isTypingTarget(e.target)) return
      if (layerCount() > 0 && !topRef.current?.()) return
      if (infoKey(e, modeRef.current)) return
      const action = keyAction(e, modeRef.current)
      if (!action) return
      // Space on a button reached with Tab presses that button, as everywhere else.
      if (e.key === ' ' && e.target instanceof HTMLElement && e.target.closest('button, a')) return
      e.preventDefault()
      const s = useSort.getState()
      if (e.repeat && (s.sending || s.queue.length > 0)) return
      s.press(action)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** I shows or hides the information column (one picture at a time only). */
function infoKey(e: KeyboardEvent, mode: SortMode): boolean {
  const isI = e.code === 'KeyI' || e.key.toLowerCase() === 'i'
  if (!isI || mode === 'bracket' || e.ctrlKey || e.metaKey || e.altKey) return false
  e.preventDefault()
  const prefs = useSortPrefs.getState()
  prefs.setInfo(!prefs.info)
  return true
}

/** After a click on the sort page, no button keeps the focus: the next Space skips instead of pressing it again. */
export function releaseButtonFocus(): void {
  const el = document.activeElement
  if (el instanceof HTMLButtonElement) el.blur()
}
