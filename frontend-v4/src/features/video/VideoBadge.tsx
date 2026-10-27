import type { ImageSummary } from '../../api/types'
import { useT } from '../../i18n'
import styles from './VideoBadge.module.css'
import { badgeOf, isVideo } from './videoMedia'

/** A video tile's mark: a play triangle and its length (or just "Video" until it is read). */
export function VideoBadge({ img }: { img: ImageSummary }) {
  const t = useT()
  if (!isVideo(img)) return null
  const badge = badgeOf(img)
  const text = badge.kind === 'duration' ? badge.time : badge.kind === 'unreadable' ? t('video.badgeUnreadable') : t('video.badge')
  return (
    <span className={`${styles.badge} mono`} title={t('video.badgeTitle')} data-testid="video-badge" data-kind={badge.kind}>
      <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden fill="currentColor">
        <path d="M2 1.2v7.6L8.6 5z" />
      </svg>
      {text}
    </span>
  )
}
