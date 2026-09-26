import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { thumbnailUrl } from '../../api/client'
import type { ImageSummary } from '../../api/types'
import { useT } from '../../i18n'
import { generatorCode, isTypingTarget } from '../../lib/format'
import { formatScore } from '../../lib/imageInfo'
import { useApp, type Layout, type TileSize } from '../../state/store'
import { Icon } from '../../ui/Icon'
import { PickMark } from '../../ui/PickMark'
import { NEAR_DUPLICATE, percent } from '../similar/ranking'
import { useCardMenu } from './CardMenu'
import { dragPayload, INTERNAL_DRAG } from './drag'
import styles from './Gallery.module.css'

const TILE_TARGET: Record<TileSize, number> = { s: 170, m: 236, l: 330 }
const GAP = 6

export interface GalleryHandle {
  move: (dir: 'left' | 'right' | 'up' | 'down' | 'first' | 'last') => void
}

interface Props {
  images: ImageSummary[]
  hasMore: boolean
  isFetchingMore: boolean
  fetchMore: () => void
  favorites: Set<number>
  onFavorite: (id: number, on: boolean) => void
  onReady?: (handle: GalleryHandle) => void
  /** Old results still on screen while new ones load: dimmed, not clickable. */
  stale?: boolean
  /** Likeness per image, shown on each tile while the grid is ranked by it. */
  scores?: ReadonlyMap<number, number> | undefined
}

function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

function tileHeight(img: ImageSummary | undefined, colW: number, layout: Layout): number {
  if (layout === 'grid' || !img?.width || !img.height) return Math.round(colW)
  const ratio = Math.min(Math.max(img.height / img.width, 0.45), 2.4)
  return Math.round(colW * ratio)
}

/** Dragging a card carries the original file out (ComfyUI, Explorer); our own text fields refuse it. */
function onTileDragStart(e: DragEvent, img: ImageSummary): void {
  for (const [type, value] of Object.entries(dragPayload(img, location.origin))) e.dataTransfer.setData(type, value)
  e.dataTransfer.effectAllowed = 'copyMove'
  const thumb = e.currentTarget.querySelector('img')
  if (thumb) e.dataTransfer.setDragImage(thumb, 24, 24)
}

function useRefuseCardDropsInFields(): void {
  useEffect(() => {
    const onDrop = (e: globalThis.DragEvent) => {
      if (e.dataTransfer?.types.includes(INTERNAL_DRAG) && isTypingTarget(e.target)) e.preventDefault()
    }
    window.addEventListener('drop', onDrop, true)
    return () => window.removeEventListener('drop', onDrop, true)
  }, [])
}

export function Gallery({ images, hasMore, isFetchingMore, fetchMore, favorites, onFavorite, onReady, stale, scores }: Props) {
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  const width = useElementWidth(scrollRef)
  const layout = useApp((s) => s.layout)
  const tileSize = useApp((s) => s.tileSize)
  const inspectedId = useApp((s) => s.inspectedId)
  const selection = useApp((s) => s.selection)

  const inner = Math.max(0, width - 2 * GAP)
  const target = TILE_TARGET[tileSize]
  const lanes = Math.max(1, Math.floor((inner + GAP) / (target + GAP)))
  const colW = lanes > 0 ? (inner - GAP * (lanes - 1)) / lanes : target
  const thumbSize = layout === 'grid' && colW * devicePixelRatio <= 256 ? 256 : 384

  const imagesRef = useRef(images)
  imagesRef.current = images

  const virtualizer = useVirtualizer({
    count: images.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => tileHeight(imagesRef.current[i], colW, layout),
    overscan: 6,
    lanes,
    gap: GAP,
    paddingStart: GAP,
    paddingEnd: 96,
    getItemKey: (i) => imagesRef.current[i]?.id ?? i,
  })

  useEffect(() => {
    virtualizer.measure()
  }, [virtualizer, lanes, colW, layout])

  const items = virtualizer.getVirtualItems()
  const lastIndex = items.at(-1)?.index ?? 0
  useEffect(() => {
    if (hasMore && !isFetchingMore && images.length > 0 && lastIndex >= images.length - lanes * 6) fetchMore()
  }, [lastIndex, images.length, hasMore, isFetchingMore, fetchMore, lanes])

  // Spatial keyboard movement: up/down stay in the same column, left/right
  // jump to the neighbouring column at the nearest height.
  const move = useCallback(
    (dir: 'left' | 'right' | 'up' | 'down' | 'first' | 'last') => {
      const list = imagesRef.current
      if (!list.length) return
      const state = useApp.getState()
      const cache = virtualizer.measurementsCache
      const curIndex = list.findIndex((img) => img.id === state.inspectedId)
      let next = -1
      if (curIndex < 0 || dir === 'first') {
        next = dir === 'last' ? list.length - 1 : (items[0]?.index ?? 0)
      } else if (dir === 'last') {
        next = list.length - 1
      } else {
        const cur = cache[curIndex]
        if (!cur) return
        const center = cur.start + cur.size / 2
        if (dir === 'down' || dir === 'up') {
          let best: VirtualItem | undefined
          for (const m of cache) {
            if (m.lane !== cur.lane) continue
            if (dir === 'down' && m.start > cur.start && (!best || m.start < best.start)) best = m
            if (dir === 'up' && m.start < cur.start && (!best || m.start > best.start)) best = m
          }
          next = best ? best.index : -1
          if (!best && dir === 'down' && hasMore) fetchMore()
        } else {
          const lane = cur.lane + (dir === 'right' ? 1 : -1)
          if (lane < 0 || lane >= lanes) {
            next = Math.min(list.length - 1, Math.max(0, curIndex + (dir === 'right' ? 1 : -1)))
          } else {
            let best: VirtualItem | undefined
            let bestDist = Infinity
            for (const m of cache) {
              if (m.lane !== lane) continue
              const d = Math.abs(m.start + m.size / 2 - center)
              if (d < bestDist) {
                best = m
                bestDist = d
              }
            }
            next = best ? best.index : -1
          }
        }
      }
      const img = next >= 0 ? list[next] : undefined
      if (!img) return
      state.inspect(img.id)
      virtualizer.scrollToIndex(next, { align: 'auto' })
    },
    [virtualizer, items, lanes, hasMore, fetchMore],
  )

  useEffect(() => {
    onReady?.({ move })
  }, [onReady, move])

  const onTileClick = useCallback((e: MouseEvent, id: number) => {
    const state = useApp.getState()
    if (e.ctrlKey || e.metaKey) {
      state.togglePick(id)
      state.inspect(id)
      return
    }
    if (e.shiftKey) {
      const list = imagesRef.current
      const anchorId = state.selectionAnchor ?? state.inspectedId
      const a = list.findIndex((img) => img.id === anchorId)
      const b = list.findIndex((img) => img.id === id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        state.selectRange(list.slice(lo, hi + 1).map((img) => img.id))
      } else {
        state.togglePick(id)
      }
      state.inspect(id)
      return
    }
    if (!state.cardOpen) {
      state.openLightbox(id)
      return
    }
    state.inspect(id)
  }, [])

  const onTileDouble = useCallback((id: number) => useApp.getState().openLightbox(id), [])

  // Right-click: the card's menu; it shows in the generation card too, so the menu's subject is visible.
  const onTileMenu = useCallback((e: MouseEvent, id: number) => {
    e.preventDefault()
    useApp.getState().inspect(id)
    useCardMenu.getState().show({ id, x: e.clientX, y: e.clientY, keyboard: false })
  }, [])

  useRefuseCardDropsInFields()

  const pickOrder = new Map(selection.map((id, i) => [id, i + 1]))

  return (
    <div ref={scrollRef} className={styles.scroller} data-testid="gallery-scroller" aria-busy={stale || undefined}>
      <div className={styles.canvas} style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const img = images[item.index]
          if (!img) return null
          return (
            <Tile
              key={item.key}
              img={img}
              left={GAP + item.lane * (colW + GAP)}
              top={item.start}
              width={colW}
              height={item.size}
              thumbSize={thumbSize}
              cover={layout === 'grid'}
              inspected={img.id === inspectedId}
              pick={pickOrder.get(img.id) ?? 0}
              favorite={favorites.has(img.id)}
              score={scores?.get(img.id)}
              onClick={onTileClick}
              onDouble={onTileDouble}
              onMenu={onTileMenu}
              onFavorite={onFavorite}
            />
          )
        })}
      </div>
      {isFetchingMore && <div className={styles.more}>{t('grid.loading')}</div>}
    </div>
  )
}

interface TileProps {
  img: ImageSummary
  left: number
  top: number
  width: number
  height: number
  thumbSize: number
  cover: boolean
  inspected: boolean
  pick: number
  favorite: boolean
  score: number | undefined
  onClick: (e: MouseEvent, id: number) => void
  onDouble: (id: number) => void
  onMenu: (e: MouseEvent, id: number) => void
  onFavorite: (id: number, on: boolean) => void
}

const Tile = memo(function Tile(p: TileProps) {
  const t = useT()
  const stars = p.img.user_rating ?? 0
  const aesthetic = formatScore(p.img.aesthetic_score)
  const heartLabel = p.favorite ? t('card.unfavorite') : t('card.favorite')
  return (
    <div
      className={styles.tile}
      data-inspected={p.inspected || undefined}
      data-picked={p.pick > 0 || undefined}
      data-scored={p.score !== undefined || undefined}
      data-testid="tile"
      data-id={p.img.id}
      style={{ transform: `translate(${p.left}px, ${p.top}px)`, width: p.width, height: p.height }}
      onClick={(e) => p.onClick(e, p.img.id)}
      onDoubleClick={() => p.onDouble(p.img.id)}
      onContextMenu={(e) => p.onMenu(e, p.img.id)}
      draggable
      onDragStart={(e) => onTileDragStart(e, p.img)}
      title={p.img.filename}
    >
      <img
        className={styles.img}
        data-cover={p.cover || undefined}
        src={thumbnailUrl(p.img.id, p.thumbSize)}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
      />
      <div className={styles.edge}>
        {p.score !== undefined ? (
          <span className={`${styles.score} mono`} data-near={p.score >= NEAR_DUPLICATE || undefined} data-testid="tile-score">
            {percent(p.score)}
          </span>
        ) : (
          <span className="mono">{generatorCode(p.img.generator)}</span>
        )}
        {aesthetic && (
          <span className="mono" data-testid="tile-aesthetic">
            {t('info.aes.edge', { score: aesthetic })}
          </span>
        )}
        {stars > 0 && (
          <span className={styles.stars}>
            <Icon name="star" filled size={11} />
            {stars}
          </span>
        )}
      </div>
      {/* Always there when favourited; on hover otherwise. Keyboard users have F. */}
      <button
        type="button"
        className={styles.heart}
        data-on={p.favorite || undefined}
        aria-pressed={p.favorite}
        aria-label={heartLabel}
        title={heartLabel}
        tabIndex={-1}
        draggable={false}
        onClick={(e) => {
          e.stopPropagation()
          p.onFavorite(p.img.id, !p.favorite)
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        data-testid="tile-heart"
      >
        <Icon name="heart" filled={p.favorite} size={14} />
      </button>
      {p.pick > 0 && <PickMark seed={p.img.id} order={p.pick} />}
      {p.inspected && <span className={styles.viewfinder} aria-hidden />}
    </div>
  )
})
