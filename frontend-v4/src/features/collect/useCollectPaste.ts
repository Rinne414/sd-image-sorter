import { useEffect } from 'react'
import { isTypingTarget } from '../../lib/format'
import { layerCount } from '../../ui/layers'
import { takePaste } from './collectActions'

/**
 * Ctrl+V on the library page saves a picture on the clipboard (or asks about a
 * picture address). Typing in a field is never taken over, and nothing is
 * taken while a dialog or menu is open above the page.
 */
export function useCollectPaste(): void {
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (isTypingTarget(event.target) || layerCount() > 0) return
      if (takePaste(event.clipboardData)) event.preventDefault()
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [])
}
