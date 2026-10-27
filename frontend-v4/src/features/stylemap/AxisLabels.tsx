import { useEffect, useMemo, useRef } from 'react'
import { useT } from '../../i18n'
import { readDefinitions } from './customAxes'
import { useCustom, useCustomShown } from './customStore'
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
 * difference). With the user's own axes applied, only those axes are
 * labelled, with the names the user gave their ends. A visual aid: the
 * "axis meanings" card says the same in words.
 */
export function AxisLabels({ scene }: { scene: StyleMapScene }) {
  const t = useT()
  const on = useMap((s) => s.labelsOn)
  const axes = useMap((s) => s.axes)
  const points = useMap((s) => s.points)
  const shownCustom = useCustomShown()
  const defs = useCustom((s) => s.defs)
  const custom = useMemo(() => (shownCustom ? readDefinitions(defs).names : null), [shownCustom, defs])
  const nodes = useRef(new Map<string, HTMLDivElement>())
  const data = axes.state === 'ok' && !custom ? axes.data?.axes : undefined
  const labelled: AxisName[] = custom ? AXIS_NAMES.filter((axis) => custom[axis]) : data ? [...AXIS_NAMES] : []
  const labelledKey = labelled.join('')

  useEffect(() => {
    if (!on || !labelledKey) return
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
  }, [on, data, custom, labelledKey, points, scene, t])

  if (!on || !labelled.length) return null

  const words = (axis: AxisName, end: End): string | null => {
    if (custom) {
      const names = custom[axis]
      const name = end === 'low' ? names?.a : names?.b
      return name || t(end === 'low' ? 'stylemap.custom.endA' : 'stylemap.custom.endB')
    }
    const entry = data?.[axis]
    const tags = entry?.weak ? null : endTags(entry?.[end])
    return tags ? tags.map((tag) => tagName(t, tag)).join(' · ') : null
  }

  return (
    <div className={styles.axisLabels} aria-hidden data-custom={custom ? true : undefined} data-testid="stylemap-axis-labels">
      {labelled.flatMap((axis) =>
        ENDS.map((end) => {
          const text = words(axis, end)
          return (
            <div
              key={`${axis}-${end}`}
              ref={(el) => {
                if (el) nodes.current.set(`${axis}-${end}`, el)
                else nodes.current.delete(`${axis}-${end}`)
              }}
              className={styles.axisLabel}
              data-weak={text ? undefined : true}
              data-axis={axis}
              data-end={end}
              hidden
            >
              <span className={styles.axisKey}>{axis.toUpperCase()}</span>
              <span data-arrow="before" />
              <span>{text ?? '—'}</span>
              <span data-arrow="after" />
            </div>
          )
        }),
      )}
    </div>
  )
}
