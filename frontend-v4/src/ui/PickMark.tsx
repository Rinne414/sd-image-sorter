import { memo } from 'react'
import styles from './PickMark.module.css'

// A picked frame is marked the way photographers mark a contact sheet: a quick
// china-marker box around it and the order number written in the corner.
// The wobble is deterministic per image so marks don't jitter between renders.

function rand(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

export function markerPath(seed: number): string {
  const r = rand(seed)
  const j = (amount: number) => (r() - 0.5) * 2 * amount
  const inset = 2.2
  const lo = inset
  const hi = 100 - inset
  const pts: [number, number][] = [
    [lo + 6 + j(2), lo + j(0.8)],
    [50 + j(4), lo + j(1.2)],
    [hi + j(0.8), lo + j(1)],
    [hi + j(1), 50 + j(4)],
    [hi + j(0.8), hi + j(1)],
    [50 + j(4), hi + j(1.2)],
    [lo + j(1), hi + j(0.8)],
    [lo + j(1.2), 50 + j(4)],
    [lo + j(0.8), lo + j(1)],
    // the stroke runs past where it started, as a hand-drawn box does
    [lo + 14 + j(3), lo + j(1.2) + 0.6],
  ]
  const [first, ...rest] = pts
  return `M${first![0].toFixed(1)} ${first![1].toFixed(1)}` + rest.map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`).join('')
}

export const PickMark = memo(function PickMark({ seed, order }: { seed: number; order: number }) {
  return (
    <span className={styles.mark} aria-hidden>
      <svg className={styles.box} viewBox="0 0 100 100" preserveAspectRatio="none">
        <path d={markerPath(seed)} vectorEffect="non-scaling-stroke" />
      </svg>
      <span className={`${styles.order} mono`} style={{ rotate: `${((seed % 7) - 3) * 1.2}deg` }}>
        {order}
      </span>
    </span>
  )
})
