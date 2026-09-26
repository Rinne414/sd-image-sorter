import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { thumbnailUrl } from '../../api/client'
import { useT } from '../../i18n'
import { uiZoom } from '../../lib/uiScale'
import { useApp } from '../../state/store'
import { Icon } from '../../ui/Icon'
import { Lightbox } from '../lightbox/Lightbox'
import { frameRatio, framesThatFit, stepFrame, type FilmFrame } from './filmPick'
import { useHT } from './homeText'
import { seeAllStarred, type Film } from './useFilm'
import styles from './FilmStrip.module.css'

const noop = () => {}

/**
 * The top of Home: ★5 images and the newest ones on a strip of film, as many
 * whole frames as the window holds. A frame opens the big image; the strip
 * ends with the way to every ★5 image in the library.
 */
export function FilmStrip({ film }: { film: Film }) {
  const ht = useHT()
  const images = film.frames.map((f) => f.image)
  if (film.error) {
    return (
      <div className={styles.film} data-testid="home-film">
        <p className={styles.note} role="alert">
          {ht('home.film.error', { reason: film.error.message })}
        </p>
      </div>
    )
  }
  return (
    <div className={styles.film} data-testid="home-film" aria-busy={film.loading || undefined}>
      <Reel frames={film.frames} end={film.loading ? null : <FilmEnd starredTotal={film.starredTotal} />} />
      {images.length > 0 && <Lightbox images={images} total={images.length} hasMore={false} fetchMore={noop} pickable={false} />}
    </div>
  )
}

interface Refs {
  reel: RefObject<HTMLDivElement | null>
  row: RefObject<HTMLUListElement | null>
  end: RefObject<HTMLDivElement | null>
}

/**
 * The room the frames have, in page px (zoom-proof, like the gallery): the
 * reel less its end, the frame height and the gap between frames.
 */
function useRoom({ reel, row, end }: Refs, hasEnd: boolean) {
  const [box, setBox] = useState({ width: 0, height: 0, gap: 0 })
  useLayoutEffect(() => {
    const el = reel.current
    const list = row.current
    if (!el || !list) return
    const read = () => {
      const gap = parseFloat(getComputedStyle(list).columnGap) || 0
      const tail = end.current ? end.current.offsetWidth + gap : 0
      setBox({ width: el.clientWidth - tail, height: list.clientHeight, gap })
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    if (end.current) ro.observe(end.current)
    return () => ro.disconnect()
  }, [reel, row, end, hasEnd])
  return box
}

/**
 * The frames that fit, then the end of the film right after them. One frame is
 * in the Tab order; the arrow keys move along the rest.
 */
function Reel({ frames, end }: { frames: FilmFrame[]; end: ReactNode }) {
  const ht = useHT()
  const reelRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLUListElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const box = useRoom({ reel: reelRef, row: rowRef, end: endRef }, end !== null)
  const [active, setActive] = useState(0)
  const ratios = frames.map((f) => frameRatio(f.image))
  const count = framesThatFit(ratios, box.height, box.gap, box.width)
  const current = Math.min(active, Math.max(0, count - 1))
  const size = box.height * devicePixelRatio * uiZoom() <= 256 ? 256 : 384

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const next = stepFrame(current, e.key, count)
    if (next === null) return
    e.preventDefault()
    setActive(next)
    rowRef.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
  }

  return (
    <div ref={reelRef} className={styles.reel}>
      <ul ref={rowRef} className={styles.frames} aria-label={ht('home.film.label')} onKeyDown={onKeyDown}>
        {frames.slice(0, count).map((frame, i) => (
          <Frame
            key={frame.image.id}
            frame={frame}
            place={{ n: i + 1, total: frames.length }}
            ratio={ratios[i] ?? 1}
            thumb={size}
            focusable={i === current}
            onFocus={() => setActive(i)}
          />
        ))}
      </ul>
      {end && (
        <div ref={endRef} className={styles.endSlot}>
          {end}
        </div>
      )}
    </div>
  )
}

interface FrameProps {
  frame: FilmFrame
  place: { n: number; total: number }
  ratio: number
  thumb: number
  focusable: boolean
  onFocus: () => void
}

/** One frame: the picture at its own shape, its stars printed in the corner; a click opens it big. */
function Frame({ frame: { image }, place, ratio, thumb, focusable, onFocus }: FrameProps) {
  const t = useT()
  const openLightbox = useApp((s) => s.openLightbox)
  const stars = image.user_rating ?? 0
  const parts = [t('browse.tile.label', { ...place, name: image.filename })]
  if (stars > 0) parts.push(t('browse.tile.stars', { n: stars }))
  const label = parts.join(t('browse.tile.sep'))
  return (
    <li className={styles.cell} style={{ aspectRatio: ratio }}>
      <button
        type="button"
        className={styles.frame}
        tabIndex={focusable ? 0 : -1}
        aria-label={label}
        title={label}
        onFocus={onFocus}
        onClick={() => openLightbox(image.id)}
        data-testid="home-frame"
        data-image-id={image.id}
      >
        <img src={thumbnailUrl(image.id, thumb)} alt="" loading="lazy" decoding="async" draggable={false} />
        {stars > 0 && (
          <span className={`${styles.stars} mono`} aria-hidden>
            <Icon name="star" filled size={11} />
            {stars}
          </span>
        )}
      </button>
    </li>
  )
}

/** Where the film ends: every ★5 image in the library, or how to make some. */
function FilmEnd({ starredTotal }: { starredTotal: number }) {
  const t = useT()
  const ht = useHT()
  if (starredTotal === 0) {
    return (
      <p className={styles.end} data-testid="home-film-nostars">
        <span className={styles.endTitle}>{ht('home.film.noStars')}</span>
        <span className={styles.endBody}>{ht('home.film.noStarsHint')}</span>
      </p>
    )
  }
  return (
    <button type="button" className={`${styles.end} ${styles.more}`} onClick={seeAllStarred} data-testid="home-film-all">
      <span className={styles.endTitle}>{ht('home.film.seeAll')}</span>
      <span className={`${styles.count} mono`}>{t('rail.images', { n: starredTotal })}</span>
    </button>
  )
}
