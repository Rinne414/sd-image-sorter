import { useEffect, useRef, useState } from 'react'
import styles from './VideoHover.module.css'
import { videoFileUrl } from './videoApi'
import { canPreviewInBrowser, scrubTime } from './videoMedia'

/** The pointer must rest on the tile this long before its video starts (passing over a tile starts nothing). */
const HOVER_DELAY_MS = 160

/** Stops whichever tile is playing now: only one video plays at a time, so a screenful of videos never loads at once. */
let stopActive: (() => void) | null = null

interface Props {
  id: number
  codec?: string | null
}

/**
 * Hover-to-play for a library tile that is a video (like the classic gallery):
 * the original plays muted and looped over its thumbnail once the mouse rests
 * on it, and moving across the tile scrubs (left edge = start, right edge =
 * end). It lives inside the tile and listens on it; nothing is loaded until the
 * hover starts, and a codec the browser cannot play keeps its still frame.
 */
export function VideoHover({ id, codec }: Props) {
  const anchor = useRef<HTMLSpanElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const bar = useRef<HTMLSpanElement>(null)
  const [active, setActive] = useState(false)
  const [playing, setPlaying] = useState(false)
  const playable = canPreviewInBrowser(codec)

  useEffect(() => {
    const tile = anchor.current?.parentElement
    if (!tile || !playable) return
    let timer: number | undefined
    const stop = () => {
      window.clearTimeout(timer)
      setActive(false)
      setPlaying(false)
      if (stopActive === stop) stopActive = null
    }
    const enter = (e: PointerEvent) => {
      if (e.pointerType && e.pointerType !== 'mouse') return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        stopActive?.()
        stopActive = stop
        setActive(true)
      }, HOVER_DELAY_MS)
    }
    const move = (e: PointerEvent) => {
      const v = video.current
      if (!v) return
      const rect = tile.getBoundingClientRect()
      const next = scrubTime((e.clientX - rect.left) / Math.max(1, rect.width), v.duration)
      if (next !== null) v.currentTime = next
    }
    tile.addEventListener('pointerenter', enter)
    tile.addEventListener('pointerleave', stop)
    tile.addEventListener('pointermove', move)
    tile.addEventListener('dragstart', stop)
    window.addEventListener('blur', stop)
    return () => {
      stop()
      tile.removeEventListener('pointerenter', enter)
      tile.removeEventListener('pointerleave', stop)
      tile.removeEventListener('pointermove', move)
      tile.removeEventListener('dragstart', stop)
      window.removeEventListener('blur', stop)
    }
  }, [id, playable])

  const paint = () => {
    const v = video.current
    if (v && bar.current && v.duration > 0) bar.current.style.setProperty('--scrub', `${(v.currentTime / v.duration) * 100}%`)
  }

  return (
    <>
      <span ref={anchor} hidden />
      {active && (
        <>
          <video
            ref={video}
            className={styles.video}
            data-playing={playing || undefined}
            src={videoFileUrl(id)}
            muted
            loop
            autoPlay
            playsInline
            preload="auto"
            aria-hidden
            data-testid="video-hover"
            onPlaying={() => setPlaying(true)}
            onTimeUpdate={paint}
            onError={() => setActive(false)}
          />
          <span ref={bar} className={styles.bar} aria-hidden />
        </>
      )}
    </>
  )
}
