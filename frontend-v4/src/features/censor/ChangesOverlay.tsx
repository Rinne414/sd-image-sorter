import { useLayoutEffect, useRef, type CSSProperties } from 'react'
import styles from './CanvasView.module.css'
import { useCanvasPixels } from './pixels'
import type { Raster } from './raster'

// "Show changes" (H): every pixel that differs from the original file is
// painted over in the marker colour, so nothing censored (or not) is missed.
// Drawn over the picture, never saved.

/** '#rrggbb' of a CSS colour token, read from the page (tokens live in tokens.css only). */
function tokenRgb(el: Element, name: string): [number, number, number] {
  const hex = getComputedStyle(el).getPropertyValue(name).trim()
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  const v = m ? Number.parseInt(m[1] as string, 16) : 0
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

/** The changed pixels as an RGBA image: marker colour where they differ, clear elsewhere. Returns how many differ. */
export function paintChanges(result: Raster, original: Raster, into: Uint8ClampedArray, rgb: readonly [number, number, number]): number {
  const a = result.data
  const b = original.data
  let changed = 0
  for (let p = 0; p < a.length; p += 4) {
    const differs = a[p] !== b[p] || a[p + 1] !== b[p + 1] || a[p + 2] !== b[p + 2] || a[p + 3] !== b[p + 3]
    if (!differs) {
      into[p + 3] = 0
      continue
    }
    changed++
    into[p] = rgb[0]
    into[p + 1] = rgb[1]
    into[p + 2] = rgb[2]
    into[p + 3] = 150
  }
  return changed
}

interface Props {
  imageId: number
  style: CSSProperties | undefined
}

export function ChangesOverlay({ imageId, style }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const { result, original, version } = useCanvasPixels()
  const mine = useCanvasPixels((s) => s.imageId === imageId)

  useLayoutEffect(() => {
    const canvas = ref.current
    if (!canvas || !mine || !result || !original) return
    canvas.width = result.width
    canvas.height = result.height
    const image = new ImageData(result.width, result.height)
    const changed = paintChanges(result, original, image.data, tokenRgb(canvas, '--marker'))
    canvas.getContext('2d')?.putImageData(image, 0, 0)
    canvas.dataset.changed = String(changed)
  }, [mine, result, original, version])

  if (!mine || !result) return null
  return <canvas ref={ref} className={styles.changes} style={style} aria-hidden data-testid="censor-changes" />
}
