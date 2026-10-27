import { useEffect, useMemo, useRef, useState } from 'react'
import { thumbnailUrl } from '../../api/urls'
import { useT } from '../../i18n'
import { useCustomShown } from './customStore'
import { assignRegions } from './geometry'
import { useMap } from './mapStore'
import styles from './MapCanvas.module.css'
import { CARD_SIZES, cardSizeFor, MAX_LANDMARKS, placeCards, summaryParts, type CardSize } from './overlays'
import type { SceneView, StyleMapScene } from './scene'
import { onCamera } from './sceneHandle'
import { tagName } from './tagNames'
import type { Region } from './types'

const THUMB = 256

/**
 * Region landmarks: what a corner of the map stands for. One solid card per
 * region (its picture and at most one line), re-placed only when the camera
 * moved. Hovering a card opens it (second picture, every label, the count)
 * and lights that region's dots. The wheel still zooms the map over a card.
 */
export function Landmarks({ scene }: { scene: StyleMapScene }) {
  const regions = useMap((s) => s.regions)
  const on = useMap((s) => s.landmarksOn)
  const points = useMap((s) => s.points)
  // The regions describe the model's layout: never drawn over the user's own axes.
  const custom = useCustomShown() !== null
  const shown = useMemo(() => (on && !custom ? regions.slice(0, MAX_LANDMARKS) : []), [on, custom, regions])
  const [open, setOpen] = useState(-1)
  const [size, setSize] = useState<CardSize>('large')
  const cards = useRef<(HTMLDivElement | null)[]>([])
  const lastView = useRef<SceneView | null>(null)
  // The dots of each region, for lighting one (the nearest centre, as the regions were fitted).
  const labels = useMemo(() => (shown.length ? assignRegions(scene.positions, scene.count, shown) : null), [shown, points, scene])

  useEffect(() => setOpen(-1), [shown])
  useEffect(() => {
    scene.setFocus(labels, open >= 0 ? open : null)
  }, [labels, open, scene])
  useEffect(() => () => scene.setFocus(null, null), [scene])

  useEffect(() => {
    const place = (view: SceneView) => {
      lastView.current = view
      const nextSize = cardSizeFor(view.width, view.height)
      setSize(nextSize)
      const projected = shown.map((r) => scene.project(r.center, view))
      const openCard = cards.current[open]
      const openBox = openCard ? { w: openCard.offsetWidth, h: openCard.offsetHeight } : null
      const places = placeCards(projected, view, nextSize, open, openBox)
      places.forEach((p, i) => {
        const card = cards.current[i]
        if (!card) return
        card.hidden = p.hidden
        if (p.hidden) return
        card.dataset.compact = p.compact && i !== open ? 'true' : 'false'
        card.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) scale(${p.scale.toFixed(3)})`
        card.style.opacity = p.opacity.toFixed(3)
      })
    }
    return onCamera(place)
  }, [shown, open, scene])

  if (!shown.length) return null
  const metrics = CARD_SIZES[size]
  const vars = { '--thumb': `${metrics.thumb}px`, '--pad': `${metrics.pad}px`, '--gap': `${metrics.gap}px` } as React.CSSProperties

  const forwardWheel = (e: React.WheelEvent) => {
    scene.canvas.dispatchEvent(new WheelEvent('wheel', { deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, cancelable: true }))
  }

  return (
    <div className={styles.landmarks} style={vars} data-size={size} data-testid="stylemap-landmarks" onWheel={forwardWheel}>
      {shown.map((region, i) => (
        <LandmarkCard
          key={region.id}
          region={region}
          open={i === open}
          refFn={(el) => {
            cards.current[i] = el
          }}
          onEnter={() => setOpen(i)}
          onLeave={() => setOpen((cur) => (cur === i ? -1 : cur))}
        />
      ))}
    </div>
  )
}

function LandmarkCard({ region, open, refFn, onEnter, onLeave }: { region: Region; open: boolean; refFn: (el: HTMLDivElement | null) => void; onEnter: () => void; onLeave: () => void }) {
  const t = useT()
  const reps = region.representatives ?? []
  const { tags, artist } = summaryParts(region)
  const line = tags.length ? tags.map((tag) => tagName(t, tag)).join(' · ') : artist ? t('stylemap.landmark.artistShort', { artist }) : ''
  return (
    <div ref={refFn} className={styles.landmark} data-open={open || undefined} hidden onMouseEnter={onEnter} onMouseLeave={onLeave} data-testid="stylemap-landmark">
      <div className={styles.landmarkThumbs}>
        {reps.slice(0, open ? 2 : 1).map((id) => (
          <img key={id} src={thumbnailUrl(id, THUMB)} alt="" decoding="async" />
        ))}
      </div>
      {line && !open && <div className={styles.landmarkText}>{line}</div>}
      {open && (
        <div className={styles.landmarkDetail}>
          {tags.length > 0 && <div>{tags.map((tag) => tagName(t, tag)).join(' · ')}</div>}
          {(region.artists ?? []).map((a) => (
            <div key={a.artist}>{t('stylemap.landmark.artist', { artist: a.artist, count: a.count, total: a.high_total })}</div>
          ))}
          <div className={styles.landmarkCount}>{t('stylemap.landmark.count', { n: region.members_total ?? region.size ?? 0 })}</div>
        </div>
      )}
    </div>
  )
}
