import type { CSSProperties } from 'react'
import { detectionsOf } from './detection'
import type { Op, RegionOp } from './ops'
import styles from './RegionOverlay.module.css'

// In review mode, the detected regions drawn over the picture with their
// numbers (the keys 1-9 switch them). Never part of the saved image. The SVG
// sits in image pixels under the same transform as the canvas, so outlines
// follow zoom and pan; strokes keep their screen width.

function outline(region: RegionOp) {
  const shape = region.shape
  if (shape.type === 'polygon') {
    const points = []
    for (let i = 0; i + 1 < shape.points.length; i += 2) points.push(`${shape.points[i]},${shape.points[i + 1]}`)
    return { el: <polygon points={points.join(' ')} />, x: shape.points[0] ?? 0, y: shape.points[1] ?? 0 }
  }
  return { el: <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} />, x: shape.x, y: shape.y }
}

interface Props {
  ops: readonly Op[]
  width: number
  height: number
  zoom: number
  style: CSSProperties | undefined
}

export function RegionOverlay({ ops, width, height, zoom, style }: Props) {
  const regions = detectionsOf(ops)
  if (regions.length === 0) return null
  const font = 13 / zoom
  return (
    <svg className={styles.overlay} style={style} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden data-testid="censor-region-overlay">
      {regions.map((region, i) => {
        const { el, x, y } = outline(region)
        return (
          <g key={region.id} className={styles.region} data-off={region.off || undefined}>
            <g className={styles.halo}>{el}</g>
            <g className={styles.line}>{el}</g>
            {i < 9 && (
              <text x={x} y={y} dx={3 / zoom} dy={font} fontSize={font} className={styles.number}>
                {i + 1}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
