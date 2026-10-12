import type { Virtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, type RefObject } from 'react'
import type { ImageSummary } from '../../api/types'
import { useT } from '../../i18n'
import { firstVisibleIndex, parseScrollStore, rememberSpot, resumeIndex, spotToResume, type ScrollSpot } from '../../lib/scrollMemory'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'

// The grid comes back to where it was for this search (lib/scrollMemory.ts):
// after a reload, and after a visit to another tab. Saved while scrolling;
// restored once the pages holding that image are loaded, unless the user
// scrolls first.

const KEY = 'sd-v4-scroll'
const SAVE_DELAY_MS = 250
/** A spot saved before this page load is from an earlier visit: say so, once. */
const PAGE_LOADED_AT = Date.now()
let welcomedBack = false

function readStore() {
  try {
    return parseScrollStore(localStorage.getItem(KEY))
  } catch {
    return {}
  }
}

function saveSpot(libraryId: string, spot: ScrollSpot): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rememberSpot(readStore(), libraryId, spot)))
  } catch {
    // storage blocked: the grid just starts at the top next time
  }
}

interface Options {
  scrollRef: RefObject<HTMLDivElement | null>
  virtualizer: Virtualizer<HTMLDivElement, Element>
  images: ImageSummary[]
  /** The search this grid shows; undefined: nothing to remember (a ranking, a random order). */
  scrollKey: string | undefined
  /** The grid knows its width, so positions are real. */
  ready: boolean
  hasMore: boolean
  isFetchingMore: boolean
  fetchMore: () => void
}

export function useScrollMemory(o: Options): void {
  const t = useT()
  const libraryId = useApp((s) => s.libraryId)
  const imagesRef = useRef(o.images)
  imagesRef.current = o.images
  // Decided once per grid (the grid remounts for another search or library).
  const pending = useRef<ScrollSpot | null | undefined>(undefined)
  if (pending.current === undefined) pending.current = o.scrollKey ? spotToResume(readStore(), libraryId, o.scrollKey, Date.now()) : null

  const { ready, images, hasMore, isFetchingMore, fetchMore, virtualizer, scrollRef } = o
  useEffect(() => {
    const spot = pending.current
    if (!spot || !ready || images.length === 0) return
    const at = resumeIndex(spot, images.map((img) => img.id))
    if (at === null && hasMore) {
      if (!isFetchingMore) fetchMore()
      return
    }
    pending.current = null
    // fewer images than before: the end is the closest place
    virtualizer.scrollToIndex(at ?? images.length - 1, { align: 'start' })
    if (spot.at < PAGE_LOADED_AT && !welcomedBack) {
      welcomedBack = true
      useToasts.getState().push(t('browse.resume.back'), 'info', {
        label: t('browse.resume.top'),
        run: () => scrollRef.current?.scrollTo({ top: 0 }),
      })
    }
  }, [ready, images, hasMore, isFetchingMore, fetchMore, virtualizer, scrollRef, t])

  // The user moving first wins over a restore still waiting for pages.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const cancel = () => {
      pending.current = null
    }
    el.addEventListener('wheel', cancel, { passive: true })
    el.addEventListener('pointerdown', cancel)
    window.addEventListener('keydown', cancel)
    return () => {
      el.removeEventListener('wheel', cancel)
      el.removeEventListener('pointerdown', cancel)
      window.removeEventListener('keydown', cancel)
    }
  }, [scrollRef])

  const { scrollKey } = o
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !scrollKey) return
    let timer: number | undefined
    let top = el.scrollTop
    const save = () => {
      timer = undefined
      if (pending.current) return
      const index = firstVisibleIndex(virtualizer.measurementsCache, top)
      const img = imagesRef.current[index]
      if (img) saveSpot(libraryId, { key: scrollKey, index, id: img.id, at: Date.now() })
    }
    const onScroll = () => {
      top = el.scrollTop
      timer ??= window.setTimeout(save, SAVE_DELAY_MS)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      // leaving (another tab, another search) right after scrolling still counts
      if (timer !== undefined) {
        window.clearTimeout(timer)
        save()
      }
    }
  }, [scrollRef, scrollKey, libraryId, virtualizer])
}
