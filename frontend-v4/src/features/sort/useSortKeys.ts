import { useEffect } from 'react'
import { isTypingTarget } from '../../lib/format'
import { useApp } from '../../state/store'
import { layerCount } from '../../ui/layers'
import { keyAction } from './sortSession'
import { useSort } from './sortStore'

/**
 * W A S D, Space / →, Backspace, Z / Y while a sort session is on screen.
 * Never while typing, while a dialog or menu floats above the page, or on
 * another page. A held key repeats only as fast as the backend answers, so
 * letting go never leaves a backlog of moves behind.
 */
export function useSortKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useApp.getState().page !== 'sort' || layerCount() > 0 || e.isComposing || isTypingTarget(e.target)) return
      const action = keyAction(e)
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

/** After a click on the sort page, no button keeps the focus: the next Space skips instead of pressing it again. */
export function releaseButtonFocus(): void {
  const el = document.activeElement
  if (el instanceof HTMLButtonElement) el.blur()
}
