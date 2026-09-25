import { useEffect, useRef, useState } from 'react'
import { thumbnailUrl } from '../../api/client'
import type { Batch, BatchItem } from '../../api/types'
import { useT } from '../../i18n'
import { parseReviewed } from '../censor/ops'
import { useCensoredUrl } from './exportApi'
import styles from './ItemImage.module.css'

/** True once the element has come near the screen (then stays true). */
function useSeen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: '300px' })
    io.observe(el)
    return () => io.disconnect()
  }, [ref, seen])
  return seen
}

interface Props {
  batch: Batch
  item: BatchItem
  /** Thumbnail size asked from the server when there is no censored copy. */
  size: number
}

/**
 * The picture as it will be posted: the censored copy when there is one
 * (the frame stays empty until it arrives, so the uncensored picture never
 * flashes), else the library thumbnail.
 */
export function ItemImage({ batch, item, size }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const seen = useSeen(ref)
  const censored = useCensoredUrl(batch, item, seen)
  const src = item.has_censored ? censored : seen ? thumbnailUrl(item.image_id, size) : null
  return (
    <div ref={ref} className={styles.box}>
      {src && <img src={src} alt="" decoding="async" draggable={false} data-censored={item.has_censored || undefined} />}
    </div>
  )
}

/** Small marks under an image: censored or not, and where review stands. */
export function ItemBadges({ item }: { item: BatchItem }) {
  const t = useT()
  const reviewed = parseReviewed(item.item_state)
  return (
    <span className={styles.badges}>
      {item.has_censored ? (
        <span className={styles.badge} data-tone="ok" data-testid="badge-censored">
          {t('batch.badge.censored')}
        </span>
      ) : (
        <span className={styles.badge} data-tone="warn" data-testid="badge-missing">
          {t('batch.badge.missing')}
        </span>
      )}
      {reviewed === true && (
        <span className={styles.badge} data-tone="ok" data-testid="badge-reviewed">
          {t('batch.badge.reviewed')}
        </span>
      )}
      {reviewed === false && (
        <span className={styles.badge} data-tone="warn" data-testid="badge-unreviewed">
          {t('batch.badge.unreviewed')}
        </span>
      )}
    </span>
  )
}
