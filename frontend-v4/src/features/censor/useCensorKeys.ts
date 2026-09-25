import { useEffect, useRef } from 'react'
import { useApp } from '../../state/store'
import { layerCount } from '../../ui/layers'
import { focusKind, keyAction, type KeyAction } from './keys'
import { useCanvasView } from './view'

/**
 * The editor's keys. The listener exists only while the editor is mounted, so
 * [ ] B P E and the arrows never act anywhere else; anything floating above the
 * page (a dialog, the palette) takes the keys first. Space held over the
 * picture turns dragging into panning.
 */
export function useCensorKeys(run: (action: KeyAction) => void): void {
  const runRef = useRef(run)
  runRef.current = run

  useEffect(() => {
    const view = useCanvasView.getState
    const onDown = (e: KeyboardEvent) => {
      if (layerCount() > 0 || useApp.getState().page !== 'batch') return
      const focus = focusKind(e.target)
      if (e.key === ' ' && focus !== 'text' && (view().hover || view().panKey)) {
        e.preventDefault()
        if (!view().panKey) view().setPanKey(true)
        return
      }
      const action = keyAction(e, focus)
      if (!action) return
      e.preventDefault()
      runRef.current(action)
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== ' ' || !view().panKey) return
      e.preventDefault()
      view().setPanKey(false)
    }
    const release = () => view().setPanKey(false)
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', release)
      release()
    }
  }, [])
}
