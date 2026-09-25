import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { imageFileUrl, thumbnailUrl } from '../../api/client'
import { useFavorites, useImageDetail, useSetRating, useToggleFavorite } from '../../api/queries'
import type { ImageSummary } from '../../api/types'
import { useT } from '../../i18n'
import { isTypingTarget } from '../../lib/format'
import { useApp } from '../../state/store'
import { GenerationCard } from '../card/GenerationCard'
import { Stars } from '../card/Stars'
import { copyAndSay, openImageFolder } from '../library/fileActions'
import { lightboxKey, type LightboxKey } from '../library/keys'
import { Icon } from '../../ui/Icon'
import { useLayer } from '../../ui/layers'
import styles from './Lightbox.module.css'

const STRIP_RADIUS = 14
const INFO_KEY = 'sd-v4-lightbox-info'

interface Props {
  images: ImageSummary[]
  total: number
  hasMore: boolean
  fetchMore: () => void
  /** Space and the Pick button add to the library's picks; off where that makes no sense (a batch). */
  pickable?: boolean
  /** The image at a position in the whole result, for one opened outside the loaded pages (a random pick). */
  fetchAt?: (offset: number) => Promise<ImageSummary | null>
}

function readInfoPref(): boolean {
  try {
    return localStorage.getItem(INFO_KEY) !== '0'
  } catch {
    return true
  }
}

/** One image up close. The film strip below keeps the neighbours in reach. */
export function Lightbox({ images, total, hasMore, fetchMore, pickable = true, fetchAt }: Props) {
  const t = useT()
  const id = useApp((s) => s.lightboxId)
  const at = useApp((s) => s.lightboxAt)
  const selection = useApp((s) => s.selection)
  const close = useApp((s) => s.closeLightbox)
  const open = useApp((s) => s.openLightbox)
  const openAt = useApp((s) => s.openLightboxAt)
  const togglePick = useApp((s) => s.togglePick)
  const favorites = useFavorites()
  const setRating = useSetRating()
  const toggleFav = useToggleFavorite()
  // The detail is fetched for the generation card anyway; lists that carry no rating read it from there.
  const detail = useImageDetail(id)
  const [info, setInfo] = useState(readInfoPref)
  const [actual, setActual] = useState(false)
  const [loadedId, setLoadedId] = useState<number | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)

  // The lightbox is a layer: Esc closes it, and it steps aside for anything opened on top.
  const isTop = useLayer(id !== null, close)

  const index = images.findIndex((img) => img.id === id)
  const current = index >= 0 ? images[index] : undefined
  // Outside the loaded pages (a random pick): step through the result on the server instead.
  const outside = index < 0 && at !== null

  // Where the last step outside the loaded pages is heading: quick presses chain from it.
  const heading = useRef<number | null>(null)
  const stepTo = async (offset: number) => {
    if (!fetchAt || offset < 0 || offset >= total) return
    heading.current = offset
    const hit = await fetchAt(offset).catch(() => null)
    if (heading.current !== offset) return
    heading.current = null
    if (!hit) return
    setActual(false)
    if (images.some((img) => img.id === hit.id)) open(hit.id)
    else openAt(hit.id, offset)
  }

  const go = (delta: 1 | -1) => {
    if (index < 0) {
      const from = heading.current ?? at
      if (from !== null) void stepTo(from + delta)
      return
    }
    const next = images[index + delta]
    if (next) {
      setActual(false)
      open(next.id)
    }
    if (delta > 0 && index + delta >= images.length - 5 && hasMore) fetchMore()
  }

  /** What a big-image key does here; false when it does not apply (the key is left alone). */
  const act = (action: LightboxKey, cur: number): boolean => {
    switch (action.type) {
      case 'go':
        go(action.delta)
        return true
      case 'first':
        if (images[0]) open(images[0].id)
        return true
      case 'last': {
        const last = images.at(-1)
        if (outside) void stepTo(total - 1)
        else if (last) open(last.id)
        return true
      }
      case 'pick':
        if (pickable) togglePick(cur)
        return pickable
      case 'rate':
        setRating.mutate({ ids: [cur], stars: action.stars })
        return true
      case 'favorite':
        toggleFav.mutate({ ids: [cur], favorited: !(favorites.data?.ids.has(cur) ?? false) })
        return true
      case 'info':
        toggleInfo()
        return true
      case 'zoom':
        setActual((a) => !a)
        return true
    }
  }

  useEffect(() => {
    if (id === null) return
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || !isTop()) return
      const cur = useApp.getState().lightboxId
      const action = lightboxKey(e)
      if (cur === null || !action || !act(action, cur)) return
      e.preventDefault()
      e.stopPropagation()
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
  const strip = index >= 0 ? images.slice(lo, index + STRIP_RADIUS + 1) : []
  const picked = selection.includes(id)
  const isFav = favorites.data?.ids.has(id) ?? false
  const position = index >= 0 ? index + 1 : at !== null ? at + 1 : null
  const path = detail.data?.image.path ?? current?.path ?? null
  const atStart = index >= 0 ? index <= 0 : !outside || (at ?? 0) <= 0
  const atEnd = index >= 0 ? index >= images.length - 1 && !hasMore : !outside || !fetchAt || (at ?? 0) >= total - 1

  return createPortal(
    <div className={styles.overlay} role="dialog" aria-modal="true" data-testid="lightbox" data-info={info || undefined}>
      <header className={styles.bar}>
        {position !== null && <span className={`${styles.pos} mono`}>{t('lightbox.position', { i: position, n: total })}</span>}
        <span className={`${styles.name} mono`} title={path ?? undefined}>
          {current?.filename ?? detail.data?.image.filename}
        </span>
        <button
          type="button"
          className={`btn btn-ghost btn-icon ${styles.fileBtn}`}
          onClick={() => void openImageFolder(id)}
          title={t('lib.file.openFolder')}
          aria-label={t('lib.file.openFolder')}
          data-testid="lightbox-open-folder"
        >
          <Icon name="folder" size={15} />
        </button>
        {path && (
          <button
            type="button"
            className={`btn btn-ghost btn-icon ${styles.fileBtn}`}
            onClick={() => void copyAndSay(path, { key: 'lib.file.path' })}
            title={t('lib.file.copyPath')}
            aria-label={t('lib.file.copyPath')}
            data-testid="lightbox-copy-path"
          >
            <Icon name="copy" size={14} />
          </button>
        )}
        <span className={styles.barGap} />
        <Stars value={detail.data?.image.user_rating ?? current?.user_rating ?? 0} onChange={(n) => setRating.mutate({ ids: [id], stars: n })} />
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
        {pickable && (
          <button type="button" className="btn" aria-pressed={picked} onClick={() => togglePick(id)}>
            {picked ? t('lightbox.picked') : t('lightbox.pick')} <kbd>Space</kbd>
          </button>
        )}
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
          <button type="button" className={`${styles.nav} ${styles.prev}`} onClick={() => go(-1)} disabled={atStart} aria-label={t('lightbox.prev')}>
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
              alt={current?.filename ?? detail.data?.image.filename ?? ''}
              draggable={false}
              onLoad={() => setLoadedId(id)}
            />
          </div>
          <button type="button" className={`${styles.nav} ${styles.next}`} onClick={() => go(1)} disabled={atEnd} aria-label={t('lightbox.next')}>
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
            data-picked={(pickable && selection.includes(img.id)) || undefined}
            onClick={() => open(img.id)}
          >
            <img src={thumbnailUrl(img.id, 256)} alt="" loading="lazy" decoding="async" draggable={false} />
          </button>
        ))}
      </div>
    </div>,
    document.body,
  )
}
