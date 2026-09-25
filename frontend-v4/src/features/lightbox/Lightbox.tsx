import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { imageFileUrl, thumbnailUrl } from '../../api/client'
import { useFavorites, useSetRating, useToggleFavorite } from '../../api/queries'
import type { ImageSummary } from '../../api/types'
import { useT } from '../../i18n'
import { isTypingTarget } from '../../lib/format'
import { useApp } from '../../state/store'
import { GenerationCard } from '../card/GenerationCard'
import { Stars } from '../card/Stars'
import { Icon } from '../../ui/Icon'
import styles from './Lightbox.module.css'

const STRIP_RADIUS = 14
const INFO_KEY = 'sd-v4-lightbox-info'

interface Props {
  images: ImageSummary[]
  total: number
  hasMore: boolean
  fetchMore: () => void
}

function readInfoPref(): boolean {
  try {
    return localStorage.getItem(INFO_KEY) !== '0'
  } catch {
    return true
  }
}

/** One image up close. The film strip below keeps the neighbours in reach. */
export function Lightbox({ images, total, hasMore, fetchMore }: Props) {
  const t = useT()
  const id = useApp((s) => s.lightboxId)
  const selection = useApp((s) => s.selection)
  const close = useApp((s) => s.closeLightbox)
  const open = useApp((s) => s.openLightbox)
  const togglePick = useApp((s) => s.togglePick)
  const favorites = useFavorites()
  const setRating = useSetRating()
  const toggleFav = useToggleFavorite()
  const [info, setInfo] = useState(readInfoPref)
  const [actual, setActual] = useState(false)
  const [loadedId, setLoadedId] = useState<number | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)

  const index = images.findIndex((img) => img.id === id)
  const current = index >= 0 ? images[index] : undefined

  const go = (delta: number) => {
    const next = images[index + delta]
    if (next) {
      setActual(false)
      open(next.id)
    }
    if (delta > 0 && index + delta >= images.length - 5 && hasMore) fetchMore()
  }

  useEffect(() => {
    if (id === null) return
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || useApp.getState().paletteOpen) return
      const state = useApp.getState()
      const cur = state.lightboxId
      if (cur === null) return
      const key = e.key
      let handled = true
      if (key === 'Escape') close()
      else if (key === 'ArrowRight' || key === 'ArrowDown') go(1)
      else if (key === 'ArrowLeft' || key === 'ArrowUp') go(-1)
      else if (key === 'Home' && images[0]) open(images[0].id)
      else if (key === 'End') {
        const last = images.at(-1)
        if (last) open(last.id)
      } else if (key === ' ') togglePick(cur)
      else if (/^[0-5]$/.test(key) && !e.ctrlKey && !e.metaKey) setRating.mutate({ ids: [cur], stars: Number(key) })
      else if (key === 'f' || key === 'F') {
        const fav = favorites.data?.ids.has(cur) ?? false
        toggleFav.mutate({ ids: [cur], favorited: !fav })
      } else if (key === 'i' || key === 'I') toggleInfo()
      else if (key === 'z' || key === 'Z') setActual((a) => !a)
      else handled = false
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  useEffect(() => {
    const strip = stripRef.current
    const active = strip?.querySelector<HTMLElement>('[data-active]')
    if (strip && active) {
      strip.scrollTo({ left: active.offsetLeft - strip.clientWidth / 2 + active.clientWidth / 2, behavior: 'smooth' })
    }
  }, [id])

  if (id === null) return null

  function toggleInfo() {
    setInfo((v) => {
      try {
        localStorage.setItem(INFO_KEY, v ? '0' : '1')
      } catch {
        // storage blocked
      }
      return !v
    })
  }

  const lo = Math.max(0, index - STRIP_RADIUS)
  const strip = images.slice(lo, Math.max(index, 0) + STRIP_RADIUS + 1)
  const picked = selection.includes(id)
  const isFav = favorites.data?.ids.has(id) ?? false

  return createPortal(
    <div className={styles.overlay} role="dialog" aria-modal="true" data-testid="lightbox" data-info={info || undefined}>
      <header className={styles.bar}>
        <span className={`${styles.pos} mono`}>
          {t('lightbox.position', { i: index + 1, n: total })}
        </span>
        <span className={`${styles.name} mono`}>{current?.filename}</span>
        <span className={styles.barGap} />
        <Stars value={current?.user_rating ?? 0} onChange={(n) => setRating.mutate({ ids: [id], stars: n })} />
        <button
          type="button"
          className={styles.heart}
          data-on={isFav || undefined}
          aria-pressed={isFav}
          title={isFav ? t('card.unfavorite') : t('card.favorite')}
          onClick={() => toggleFav.mutate({ ids: [id], favorited: !isFav })}
        >
          <Icon name="heart" filled={isFav} size={17} />
        </button>
        <button type="button" className="btn" aria-pressed={picked} onClick={() => togglePick(id)}>
          {picked ? t('lightbox.picked') : t('lightbox.pick')} <kbd>Space</kbd>
        </button>
        <button type="button" className="btn" aria-pressed={actual} onClick={() => setActual(!actual)}>
          {actual ? t('lightbox.fit') : t('lightbox.actual')} <kbd>Z</kbd>
        </button>
        <button type="button" className="btn" aria-pressed={info} onClick={toggleInfo}>
          {t('lightbox.info')} <kbd>I</kbd>
        </button>
        <button type="button" className="btn btn-icon btn-ghost" onClick={close} title={t('lightbox.close')} aria-label={t('lightbox.close')}>
          <Icon name="close" />
        </button>
      </header>

      <div className={styles.body}>
        <div className={styles.stage} data-actual={actual || undefined} onClick={(e) => e.target === e.currentTarget && close()}>
          <button type="button" className={`${styles.nav} ${styles.prev}`} onClick={() => go(-1)} disabled={index <= 0} aria-label={t('lightbox.prev')}>
            <Icon name="left" size={28} />
          </button>
          <div className={styles.imgWrap} onClick={() => setActual(!actual)}>
            {/* The thumbnail holds the frame until the full image is ready: no black flash. */}
            <img className={styles.under} src={thumbnailUrl(id, 384)} alt="" draggable={false} />
            <img
              key={id}
              className={styles.full}
              data-ready={loadedId === id || undefined}
              src={imageFileUrl(id)}
              alt={current?.filename ?? ''}
              draggable={false}
              onLoad={() => setLoadedId(id)}
            />
          </div>
          <button type="button" className={`${styles.nav} ${styles.next}`} onClick={() => go(1)} disabled={index >= images.length - 1 && !hasMore} aria-label={t('lightbox.next')}>
            <Icon name="right" size={28} />
          </button>
        </div>
        {info && <GenerationCard id={id} variant="overlay" />}
      </div>

      <div ref={stripRef} className={styles.strip}>
        {strip.map((img) => (
          <button
            key={img.id}
            type="button"
            className={styles.frame}
            data-active={img.id === id || undefined}
            data-picked={selection.includes(img.id) || undefined}
            onClick={() => open(img.id)}
          >
            <img src={thumbnailUrl(img.id, 256)} alt="" loading="lazy" draggable={false} />
          </button>
        ))}
      </div>
    </div>,
    document.body,
  )
}
