import type { Rect } from './marquee'
import styles from './MarqueeBox.module.css'

/** The box being drawn over a batch grid, in the grid's scrolled content. */
export function MarqueeBox({ box }: { box: Rect | null }) {
  if (!box) return null
  return (
    <div
      className={styles.box}
      style={{ left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top }}
      aria-hidden
      data-testid="batch-marquee"
    />
  )
}
