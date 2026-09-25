import { useLayoutEffect, useRef, type CSSProperties } from 'react'
import { adjustRaster } from './adjust'
import styles from './CanvasView.module.css'
import type { AdjustValues } from './ops'
import type { Raster } from './raster'

interface Props {
  /** The picture as it is without the filter being tried, made small. */
  small: Raster
  values: AdjustValues
  /** The full-size canvas's width and transform: the small copy is laid exactly over it. */
  fullWidth: number
  view: { z: number; tx: number; ty: number }
}

/** The filter on a small copy while a slider moves on a big picture; replaced by the full-size preview when it rests. */
export function FastPreview({ small, values, fullWidth, view }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useLayoutEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const out = adjustRaster(small, values)
    canvas.width = out.width
    canvas.height = out.height
    canvas.getContext('2d')?.putImageData(new ImageData(out.data, out.width, out.height), 0, 0)
  }, [small, values])

  const k = (fullWidth / small.width) * view.z
  const style: CSSProperties = { width: small.width, height: small.height, transform: `translate(${view.tx}px, ${view.ty}px) scale(${k})` }
  return <canvas ref={ref} className={styles.fast} style={style} aria-hidden data-testid="censor-fast-preview" />
}
