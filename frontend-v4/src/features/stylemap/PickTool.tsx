import { useEffect, useState } from 'react'
import { pushLayer } from '../../ui/layers'
import { dotsInPolygon, dotsInRect, nearestDot, projectPoints, type UV } from './geometry'
import styles from './MapCanvas.module.css'
import { pickIndices, toggleIndex, usePicks } from './pickStore'
import type { StyleMapScene } from './scene'
import { boxStyle, CLICK_SLOP_PX, dragShape, lassoPoints, PICK_RADIUS_PX, type DragShape } from './selection'

interface Drawn {
  shape: DragShape
  points: UV[]
}

/** Lasso corners closer than this (in canvas fractions) are one corner. */
const LASSO_STEP = 0.004

/**
 * Picking dots by pointer: Shift + drag draws a box, and with box or lasso
 * chosen in the bar a plain drag draws that shape; a click (no drag) with
 * Shift, or while box or lasso is chosen, adds or removes the dot under the
 * pointer. The press is taken before the orbit controls (which read Shift +
 * drag as a pan); right-drag pan and the wheel stay theirs. Positions are
 * fractions of the canvas, so the interface zoom cannot skew the shape. While
 * a shape is drawn it is the top layer: Esc drops it and nothing else.
 */
export function PickTool({ scene }: { scene: StyleMapScene }) {
  const [drawn, setDrawn] = useState<Drawn | null>(null)
  const mode = usePicks((s) => s.mode)

  useEffect(() => {
    const canvas = scene.canvas
    let drag: { shape: DragShape; points: UV[]; pointerId: number; x: number; y: number; moved: boolean; release: () => void } | null = null

    const locate = (event: PointerEvent): UV => {
      const rect = canvas.getBoundingClientRect()
      const clamp = (value: number) => Math.min(1, Math.max(0, value))
      return { u: clamp((event.clientX - rect.left) / rect.width), v: clamp((event.clientY - rect.top) / rect.height) }
    }

    const finish = () => {
      if (!drag) return
      drag.release()
      if (canvas.hasPointerCapture?.(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId)
      drag = null
      setDrawn(null)
    }

    const down = (event: PointerEvent): boolean => {
      const shape = dragShape(usePicks.getState().mode, event.shiftKey, event.button)
      if (!shape || scene.count === 0) return false
      const start = locate(event)
      drag = { shape, points: [start], pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, release: pushLayer(finish) }
      canvas.setPointerCapture?.(event.pointerId)
      return true
    }

    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < CLICK_SLOP_PX) return
      drag.moved = true
      const at = locate(event)
      if (drag.shape === 'box') drag.points = [drag.points[0]!, at]
      else {
        const last = drag.points[drag.points.length - 1]!
        if (Math.hypot(at.u - last.u, at.v - last.v) >= LASSO_STEP) drag.points = [...drag.points, at]
      }
      setDrawn({ shape: drag.shape, points: drag.points })
    }

    const up = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return
      const { shape, moved } = drag
      const end = locate(event)
      const points = shape === 'box' ? [drag.points[0]!, end] : [...drag.points, end]
      finish()
      if (scene.count === 0) return
      const projected = projectPoints(scene.positions, scene.count, scene.projectionMatrix())
      if (moved) {
        pickIndices(shape === 'box' ? dotsInRect(projected, scene.count, points[0]!, end) : dotsInPolygon(projected, scene.count, points))
        return
      }
      // A click: the dot under the pointer goes in or out of the pick; empty space does nothing.
      const index = nearestDot(projected, scene.count, end, { width: canvas.clientWidth, height: canvas.clientHeight, radiusPx: PICK_RADIUS_PX })
      if (index >= 0) toggleIndex(index)
    }

    scene.setPointerTool({ down })
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', finish)
    return () => {
      finish()
      scene.setPointerTool(null)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', finish)
    }
  }, [scene])

  // The canvas says what a drag does (the end-to-end tests read it too).
  useEffect(() => {
    scene.canvas.dataset.drag = mode
  }, [scene, mode])

  if (!drawn) return null
  if (drawn.shape === 'box') {
    const [a, b] = drawn.points
    if (!a || !b) return null
    return <div className={styles.pickBox} style={boxStyle(a, b)} aria-hidden data-testid="stylemap-pick-shape" data-shape="box" />
  }
  return (
    <svg className={styles.pickLasso} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden data-testid="stylemap-pick-shape" data-shape="lasso">
      <polygon points={lassoPoints(drawn.points)} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
