import { thumbnailUrl } from '../../api/client'
import styles from './Covers.module.css'

const SLOTS = 4

/** A short strip of a batch's first frames; empty slots stay as dark film. */
export function Covers({ ids, size = 'm' }: { ids: number[]; size?: 's' | 'm' }) {
  const slots = Array.from({ length: SLOTS }, (_, i) => ids[i] ?? null)
  return (
    <span className={styles.strip} data-size={size} aria-hidden>
      {slots.map((id, i) =>
        id === null ? (
          <span key={`empty-${i}`} className={styles.frame} />
        ) : (
          <img key={id} className={styles.frame} src={thumbnailUrl(id, 256)} alt="" loading="lazy" decoding="async" draggable={false} />
        ),
      )}
    </span>
  )
}
