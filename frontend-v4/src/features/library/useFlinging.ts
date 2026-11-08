import { useEffect, useState, type RefObject } from 'react'
import { createFlickGate } from '../../lib/flickGate'

/** True while the scroller is being flung; tiles drawn meanwhile wait for their picture. */
export function useFlinging(scrollRef: RefObject<HTMLElement | null>): boolean {
  const [flinging, setFlinging] = useState(false)
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const gate = createFlickGate({ getScrollTop: () => scroller.scrollTop, onChange: setFlinging })
    const onScroll = () => gate.noteScroll()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      gate.dispose()
    }
  }, [scrollRef])
  return flinging
}
