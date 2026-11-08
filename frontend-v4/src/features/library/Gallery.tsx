import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { thumbnailUrl } from '../../api/client'
import type { ImageSummary } from '../../api/types'
import { useT, type MessageKey, type Params } from '../../i18n'
import { generatorCode, isTypingTarget } from '../../lib/format'
import { formatScore } from '../../lib/imageInfo'
import { uiZoom } from '../../lib/uiScale'
import { useApp, type Layout, type TileSize } from '../../state/store'
import { Icon } from '../../ui/Icon'
import { PickMark } from '../../ui/PickMark'
import { NEAR_DUPLICATE, percent } from '../similar/ranking'
import { VideoBadge } from '../video/VideoBadge'
import { VideoHover } from '../video/VideoHover'
import { formatDuration, isVideo } from '../video/videoMedia'
import { useCardMenu } from './CardMenu'
import { dragPayload, INTERNAL_DRAG } from './drag'
import styles from './Gallery.module.css'
import { displayIndexOf, flatItems, groupRuns as groupRunItems, pickLabel, widenToStacks } from './runGroups'
import { useFlinging } from './useFlinging'
import { useScrollMemory } from './useScrollMemory'

const TILE_TARGET: Record<TileSize, number> = { s: 170, m: 236, l: 330 }

/**
 * How tiles mark state. 'film' (Vopus): a china-marker box with the pick
 * number and viewfinder corners. 'plain' (the /next/ interface): rounded
 * tiles, a ring on the inspected one and a numbered badge on picks.
 */
export type TileLook = 'film' | 'plain'

export interface GalleryHandle {
  move: (dir: 'left' | 'right' | 'up' | 'down' | 'first' | 'last') => void
  /** The pictures a pick of this tile means: a closed run's stack picks all of them. */
  picksFor: (id: number) => number[]
}

interface Props {
  images: ImageSummary[]
  /** Size of the whole result, for "image 3 of 120"; null when unknown (a ranking). */
  total: number | null
  /** The search to come back to after a reload or another tab; undefined: none. */
  scrollKey?: string | undefined
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
  look?: TileLook
  /** Height of a grid-layout cell as a multiple of its width (1: square). */
  gridRatio?: number
  /** Space between tiles and around the grid, in px. */
  gap?: number
  /** Show each generation run as one stack ("Group runs", runGroups.ts); the caller keeps it to date order. */
  groupRuns?: boolean
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

function tileHeight(img: ImageSummary | undefined, colW: number, layout: Layout, gridRatio = 1): number {
  if (layout === 'grid') return Math.round(colW * gridRatio)
  if (!img?.width || !img.height) return Math.round(colW)
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

type Translate = (key: MessageKey, params?: Params) => string

/** What a screen reader says for a tile: its place in the result, name, stars, marks. */
function tileLabel(t: Translate, img: ImageSummary, n: number, total: number | null, favorite: boolean, picked: boolean, stackSize = 0): string {
  const name = img.filename ?? ''
  const parts = [total === null ? t('browse.tile.labelOpen', { n, name }) : t('browse.tile.label', { n, total, name })]
  if (stackSize > 1) parts.push(t('browse.tile.stack', { n: stackSize }))
  if (isVideo(img)) parts.push(t('video.tileSpoken', { time: formatDuration(img.duration_seconds) }))
  if (img.user_rating) parts.push(t('browse.tile.stars', { n: img.user_rating }))
  if (favorite) parts.push(t('browse.tile.favorite'))
  if (picked) parts.push(t('browse.tile.picked'))
  return parts.join(t('browse.tile.sep'))
}

export function Gallery({
  images,
  total,
  scrollKey,
  hasMore,
  isFetchingMore,
  fetchMore,
  favorites,
  onFavorite,
  onReady,
  stale,
  scores,
  look = 'film',
  gridRatio = 1,
  gap = 6,
  groupRuns = false,
}: Props) {
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  const width = useElementWidth(scrollRef)
  const layout = useApp((s) => s.layout)
  const tileSize = useApp((s) => s.tileSize)
  const inspectedId = useApp((s) => s.inspectedId)
  const selection = useApp((s) => s.selection)

  const inner = Math.max(0, width - 2 * gap)
  const target = TILE_TARGET[tileSize]
  const lanes = Math.max(1, Math.floor((inner + gap) / (target + gap)))
  const colW = lanes > 0 ? (inner - gap * (lanes - 1)) / lanes : target
  // Screen pixels per tile: the interface zoom enlarges tiles like a denser screen does.
  const thumbSize = layout === 'grid' && colW * devicePixelRatio * uiZoom() <= 256 ? 256 : 384

  const imagesRef = useRef(images)
  imagesRef.current = images

  // What the grid shows: one item per picture, or with "Group runs" one per run.
  // The flat list stays the pictures: the lightbox and picks walk every one.
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(() => new Set())
  // Turning the switch starts with every run closed (nothing to do when none is open).
  useEffect(() => setOpenRuns((open) => (open.size ? new Set() : open)), [groupRuns])
  const display = useMemo(() => (groupRuns ? groupRunItems(images, openRuns) : flatItems(images)), [images, openRuns, groupRuns])
  const displayRef = useRef(display)
  displayRef.current = display
  const shownImages = useMemo(() => display.map((item) => item.img), [display])
  const onRunOpen = useCallback((key: string, open: boolean) => {
    setOpenRuns((prev) => {
      const next = new Set(prev)
      if (open) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  const virtualizer = useVirtualizer({
    count: display.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => tileHeight(displayRef.current[i]?.img, colW, layout, gridRatio),
    overscan: 6,
    lanes,
    gap,
    paddingStart: gap,
    paddingEnd: 96,
    getItemKey: (i) => displayRef.current[i]?.img.id ?? i,
  })

  useEffect(() => {
    virtualizer.measure()
  }, [virtualizer, lanes, colW, layout, gridRatio])

  const shownIndexOf = useCallback((id: number) => displayIndexOf(displayRef.current, id), [])
  useScrollMemory({ scrollRef, virtualizer, images: shownImages, scrollKey, ready: width > 0, hasMore, isFetchingMore, fetchMore, indexOf: shownIndexOf })
  const flinging = useFlinging(scrollRef)

  const items = virtualizer.getVirtualItems()
  const lastIndex = items.at(-1)?.index ?? 0
  useEffect(() => {
    if (hasMore && !isFetchingMore && display.length > 0 && lastIndex >= display.length - lanes * 6) fetchMore()
  }, [lastIndex, display.length, hasMore, isFetchingMore, fetchMore, lanes])

  // Spatial keyboard movement: up/down stay in the same column, left/right
  // jump to the neighbouring column at the nearest height.
  const move = useCallback(
    (dir: 'left' | 'right' | 'up' | 'down' | 'first' | 'last') => {
      const list = displayRef.current
      if (!list.length) return
      const state = useApp.getState()
      const cache = virtualizer.measurementsCache
      // A picture inside a closed stack is at the stack.
      const curIndex = displayIndexOf(list, state.inspectedId)
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
      const img = next >= 0 ? list[next]?.img : undefined
      if (!img) return
      state.inspect(img.id)
      virtualizer.scrollToIndex(next, { align: 'auto' })
    },
    [virtualizer, items, lanes, hasMore, fetchMore],
  )

  const picksFor = useCallback((id: number) => {
    const list = displayRef.current
    return list[displayIndexOf(list, id)]?.stack?.ids ?? [id]
  }, [])

  useEffect(() => {
    onReady?.({ move, picksFor })
  }, [onReady, move, picksFor])

  const onTileClick = useCallback((e: MouseEvent, id: number) => {
    const state = useApp.getState()
    const list = displayRef.current
    const tile = list[displayIndexOf(list, id)]
    const ids = tile?.stack?.ids ?? [id]
    const pick = () => (ids.length > 1 ? state.togglePicks(ids) : state.togglePick(id))
    if (e.ctrlKey || e.metaKey) {
      pick()
      state.inspect(id)
      return
    }
    if (e.shiftKey) {
      const flat = imagesRef.current
      const anchorId = state.selectionAnchor ?? state.inspectedId
      const a = flat.findIndex((img) => img.id === anchorId)
      const b = tile ? tile.flatIndex : -1
      if (a >= 0 && b >= 0) {
        // A closed stack is whole in a range, at either end.
        const [lo, hi] = widenToStacks(list, Math.min(a, b), Math.max(a, b))
        state.selectRange(flat.slice(lo, hi + 1).map((img) => img.id))
      } else {
        pick()
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
    // A closed run's stack: the menu acts on the whole run.
    const run = displayRef.current.find((item) => item.img.id === id)?.stack?.ids
    useCardMenu.getState().show({ id, x: e.clientX, y: e.clientY, keyboard: false, ...(run ? { run } : {}) })
  }, [])

  useRefuseCardDropsInFields()

  const pickOrder = new Map(selection.map((id, i) => [id, i + 1]))
  // Keys move the inspected image without moving focus; say where it is now.
  const inspectedIndex = inspectedId === null ? -1 : images.findIndex((img) => img.id === inspectedId)
  const inspected = inspectedIndex >= 0 ? images[inspectedIndex] : undefined
  const announcement = inspected
    ? tileLabel(t, inspected, inspectedIndex + 1, total, favorites.has(inspected.id), pickOrder.has(inspected.id))
    : ''

  return (
    <>
      <div ref={scrollRef} className={styles.scroller} data-testid="gallery-scroller" aria-busy={stale || undefined}>
        <div className={styles.canvas} style={{ height: virtualizer.getTotalSize() }} role="list" aria-label={t('browse.grid.label')}>
          {items.map((item) => {
            const shown = display[item.index]
            if (!shown) return null
            const { img, stack, member } = shown
            const pick = pickLabel(stack?.ids ?? [img.id], pickOrder)
            const inspected = inspectedId !== null && (stack ? stack.ids.includes(inspectedId) : img.id === inspectedId)
            return (
              <Tile
                key={item.key}
                label={tileLabel(t, img, shown.flatIndex + 1, total, favorites.has(img.id), pick !== '', stack?.size)}
                position={shown.flatIndex + 1}
                setSize={total ?? -1}
                img={img}
                runKey={stack?.key ?? member?.key}
                runSize={stack?.size ?? member?.size}
                runIds={stack?.ids.join(',')}
                runPlace={member ? (member.position === 0 ? 'first' : member.position === member.size - 1 ? 'last' : 'middle') : undefined}
                onRunOpen={onRunOpen}
                left={gap + item.lane * (colW + gap)}
                top={item.start}
                width={colW}
                height={item.size}
                thumbSize={thumbSize}
                flinging={flinging}
                cover={layout === 'grid'}
                inspected={inspected}
                pick={pick}
                favorite={favorites.has(img.id)}
                score={scores?.get(img.id)}
                look={look}
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
      <div className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="grid-announce">
        {announcement}
      </div>
    </>
  )
}

interface TileProps {
  /** Spoken name: position, file name, stars, marks. */
  label: string
  /** 1-based place in the result, and its size (-1: unknown), for screen readers. */
  position: number
  setSize: number
  img: ImageSummary
  /** The run this tile belongs to ("Group runs"): its key and size. Primitives, so the memo holds. */
  runKey: string | undefined
  runSize: number | undefined
  /** A closed run's stack: the ids of every picture it stands for, comma-separated. */
  runIds: string | undefined
  /** A picture of an open run: where it sits in the run. */
  runPlace: 'first' | 'middle' | 'last' | undefined
  onRunOpen: (key: string, open: boolean) => void
  left: number
  top: number
  width: number
  height: number
  thumbSize: number
  /** While true, a tile that has no picture yet waits for one (a flick passes most tiles unseen). */
  flinging: boolean
  cover: boolean
  inspected: boolean
  /** Pick order ("3", or "2–5" for a stack); empty when not picked. */
  pick: string
  favorite: boolean
  score: number | undefined
  look: TileLook
  onClick: (e: MouseEvent, id: number) => void
  onDouble: (id: number) => void
  onMenu: (e: MouseEvent, id: number) => void
  onFavorite: (id: number, on: boolean) => void
}

const Tile = memo(function Tile(p: TileProps) {
  const t = useT()
  // Drawn mid-flick: no picture until the gallery settles; once shown it stays.
  const [showPicture, setShowPicture] = useState(!p.flinging)
  useEffect(() => {
    if (!p.flinging) setShowPicture(true)
  }, [p.flinging])
  // A tile that leaves the page cancels a thumbnail still on the way.
  const pictureRef = useRef<HTMLImageElement>(null)
  useLayoutEffect(() => {
    const picture = pictureRef.current
    return () => {
      if (picture && !picture.complete && picture.getAttribute('src')) picture.removeAttribute('src')
    }
  }, [])
  const stars = p.img.user_rating ?? 0
  const aesthetic = formatScore(p.img.aesthetic_score)
  const heartLabel = p.favorite ? t('card.unfavorite') : t('card.favorite')
  const isStack = p.runIds !== undefined
  return (
    <div
      className={styles.tile}
      role="listitem"
      aria-label={p.label}
      aria-posinset={p.position}
      aria-setsize={p.setSize}
      aria-current={p.inspected || undefined}
      data-inspected={p.inspected || undefined}
      data-picked={p.pick !== '' || undefined}
      data-stack={isStack ? p.runSize : undefined}
      data-run-ids={p.runIds}
      data-run-member={p.runPlace}
      data-scored={p.score !== undefined || undefined}
      data-look={p.look}
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
        ref={pictureRef}
        className={styles.img}
        data-cover={p.cover || undefined}
        src={showPicture ? thumbnailUrl(p.img.id, p.thumbSize) : undefined}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
      />
      {isVideo(p.img) && <VideoHover id={p.img.id} codec={p.img.video_codec} />}
      <VideoBadge img={p.img} aboveCaption />
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
      {isStack && p.runKey && (
        <RunButton label={t('browse.run.open', { n: p.runSize ?? 0 })} testId="run-open" onPress={() => p.onRunOpen(p.runKey!, true)}>
          {`×${p.runSize}`}
        </RunButton>
      )}
      {p.runPlace === 'first' && p.runKey && (
        <RunButton label={t('browse.run.foldTitle', { n: p.runSize ?? 0 })} testId="run-fold" onPress={() => p.onRunOpen(p.runKey!, false)}>
          {t('browse.run.fold')}
        </RunButton>
      )}
      {p.pick !== '' &&
        (p.look === 'plain' ? (
          <span className={styles.pickBadge} aria-hidden data-testid="pick-badge">
            {p.pick}
          </span>
        ) : (
          <PickMark seed={p.img.id} order={p.pick} />
        ))}
      {p.inspected && p.look === 'film' && <span className={styles.viewfinder} aria-hidden />}
    </div>
  )
})

/** The count on a closed run's stack (opens it in place), or Fold on an open run's first picture. */
function RunButton({ label, testId, onPress, children }: { label: string; testId: string; onPress: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className={`${styles.runButton} mono`}
      title={label}
      aria-label={label}
      tabIndex={-1}
      draggable={false}
      onClick={(e) => {
        e.stopPropagation()
        onPress()
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      data-testid={testId}
    >
      {children}
    </button>
  )
}
