import { useT, type MessageKey } from '../../i18n'
import { useLibraryVideoCount } from './videoApi'
import styles from './MediaToggle.module.css'
import { withMediaFilter, type MediaFilter } from './videoMedia'

const OPTIONS: { value: MediaFilter; label: MessageKey; title: MessageKey }[] = [
  { value: '', label: 'video.media.all', title: 'video.media.allTitle' },
  { value: 'image', label: 'video.media.image', title: 'video.media.imageTitle' },
  { value: 'video', label: 'video.media.video', title: 'video.media.videoTitle' },
]

interface Props {
  /** The query line, and what to do with the line this control writes. */
  text: string
  current: MediaFilter
  onChange: (next: string) => void
}

/**
 * Pictures and videos share the library; this picks one kind. It shows only when
 * the library holds videos (or a media filter is already on, so it can be undone).
 * The choice is the query line's media: token, so it reaches every list, count
 * and "select all matches" request the line reaches.
 */
export function MediaToggle({ text, current, onChange }: Props) {
  const t = useT()
  const videos = useLibraryVideoCount()
  if (videos === 0 && current === '') return null
  return (
    <div className={styles.group} role="group" aria-label={t('video.media.label')} data-testid="media-toggle">
      {OPTIONS.map((o) => (
        <button
          key={o.value || 'all'}
          type="button"
          className={styles.option}
          aria-pressed={current === o.value}
          title={t(o.title)}
          aria-label={t(o.title)}
          onClick={() => onChange(withMediaFilter(text, o.value))}
          data-testid={`media-${o.value || 'all'}`}
          data-media={o.value}
        >
          {t(o.label)}
        </button>
      ))}
    </div>
  )
}
