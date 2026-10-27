import { useEffect, useRef } from 'react'
import { useT } from '../../i18n'
import { GRID_PAD } from './geometry'
import { useMap } from './mapStore'
import styles from './MapCanvas.module.css'
import { arrowFor, axisAnchors, endTags, placeLabel, type End, type Rect } from './overlays'
import type { SceneView, StyleMapScene } from './scene'
import { onCamera } from './sceneHandle'
import { tagName } from './tagNames'
import { AXIS_NAMES, type AxisName } from './types'

const ENDS: readonly End[] = ['low', 'high']

/**
 * What the two ends of each axis stand for, written on the floor grid: the
 * axis letter, an arrow that points the way the end lies on screen, and the
 * end's strongest tags (a faint dash when the tags cannot name the
 * difference). A visual aid: the "axis meanings" card says the same in words.
 */
export function AxisLabels({ scene }: { scene: StyleMapScene }) {
  const t = useT()
  const on = useMap((s) => s.labelsOn)
  const axes = useMap((s) => s.axes)
  const points = useMap((s) => s.points)
  const nodes = useRef(new Map<string, HTMLDivElement>())
  const data = axes.state === 'ok' ? axes.data?.axes : undefined

  useEffect(() => {
    if (!on || !data) return
    const place = (view: SceneView) => {
      const anchors = axisAnchors(scene.core, scene.floorY, scene.cloudTopY, GRID_PAD)
      const placed: Rect[] = []
      const centre = anchors ? scene.project(anchors.center, view) : null
      for (const axis of AXIS_NAMES) {
        for (const end of ENDS) {
          const node = nodes.current.get(`${axis}-${end}`)
          if (!node) continue
          if (!anchors || !centre) {
            node.hidden = true
            continue
          }
          const here = scene.project(anchors.ends[axis][end], view)
          const there = scene.project(anchors.ends[axis][end === 'low' ? 'high' : 'low'], view)
          if (here.behind) {
            node.hidden = true
            continue
          }
          // The arrow points the way this end lies, on the outer side of the words; a weak end shows only its dash.
          const arrow = node.dataset.weak === undefined ? arrowFor(here.x - there.x, here.y - there.y) : ''
          const before = node.querySelector<HTMLElement>('[data-arrow="before"]')
          const after = node.querySelector<HTMLElement>('[data-arrow="after"]')
          const last = here.x < there.x
          if (before) before.textContent = last ? '' : arrow
          if (after) after.textContent = last ? arrow : ''
          node.hidden = false
          const rect = placeLabel(here, centre, { w: node.offsetWidth, h: node.offsetHeight }, view, placed)
          placed.push(rect)
          node.style.transform = `translate(${rect.x.toFixed(1)}px, ${rect.y.toFixed(1)}px)`
        }
      }
    }
    return onCamera(place)
  }, [on, data, points, scene, t])

  if (!on || !data) return null
  return (
    <div className={styles.axisLabels} aria-hidden data-testid="stylemap-axis-labels">
      {AXIS_NAMES.flatMap((axis) =>
        ENDS.map((end) => {
          const entry = data[axis as AxisName]
          const tags = entry?.weak ? null : endTags(entry?.[end])
          const words = tags ? tags.map((tag) => tagName(t, tag)).join(' · ') : '—'
          return (
            <div
              key={`${axis}-${end}`}
              ref={(el) => {
                if (el) nodes.current.set(`${axis}-${end}`, el)
                else nodes.current.delete(`${axis}-${end}`)
              }}
              className={styles.axisLabel}
              data-weak={tags ? undefined : true}
              data-axis={axis}
              data-end={end}
              hidden
            >
              <span className={styles.axisKey}>{axis.toUpperCase()}</span>
              <span data-arrow="before" />
              <span>{words}</span>
              <span data-arrow="after" />
            </div>
          )
        }),
      )}
    </div>
  )
}
