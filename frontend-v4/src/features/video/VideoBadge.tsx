import type { ImageSummary } from '../../api/types'
import { useT } from '../../i18n'
import styles from './VideoBadge.module.css'
import { badgeOf, isVideo } from './videoMedia'

/** What a tile knows about its image: enough to tell a video and say its length. Rows from the batch lists carry only a file name. */
export type BadgeSource = Partial<Pick<ImageSummary, 'media_type' | 'duration_seconds' | 'video_probe_state'>> & {
  filename?: string | null
  path?: string | null
}

interface Props {
  img: BadgeSource
  /** Lift the mark above a caption strip along the tile's bottom edge (the library grid's hover strip). */
  aboveCaption?: boolean
}

/** A video tile's mark: a play triangle and its length (or just "Video" until it is read). Nothing for a picture. */
export function VideoBadge({ img, aboveCaption = false }: Props) {
  const t = useT()
  if (!isVideo(img)) return null
  const badge = badgeOf({ duration_seconds: img.duration_seconds ?? null, video_probe_state: img.video_probe_state ?? null })
  const text = badge.kind === 'duration' ? badge.time : badge.kind === 'unreadable' ? t('video.badgeUnreadable') : t('video.badge')
  return (
    <span className={`${styles.badge} mono`} data-above={aboveCaption || undefined} title={t('video.badgeTitle')} data-testid="video-badge" data-kind={badge.kind}>
      <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden fill="currentColor">
        <path d="M2 1.2v7.6L8.6 5z" />
      </svg>
      {text}
    </span>
  )
}
