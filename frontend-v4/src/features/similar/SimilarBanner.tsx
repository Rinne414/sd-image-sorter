import { ApiError } from '../../api/client'
import { useT } from '../../i18n'
import { Icon } from '../../ui/Icon'
import { withClip } from './clip'
import { SearchTools } from './SearchTools'
import { startIndexing, useIndexStats } from './similarApi'
import { useSimilar, type SimilarQuery } from './similarStore'
import styles from './Similar.module.css'

interface Props {
  query: SimilarQuery
  count: number
  loading: boolean
  error: Error | null
  retry: () => void
}

function useTitle(query: SimilarQuery): string {
  const t = useT()
  if (query.kind === 'text') return t('sim.banner.text', { text: query.text })
  if (query.kind === 'upload') return t('sim.banner.upload', { name: query.file.name })
  return t(query.near ? 'sim.banner.near' : 'sim.banner.image', { name: query.name })
}

/** Over the grid while it shows images ranked by likeness: what they are like, the threshold and scope, and the way back. */
export function SimilarBanner({ query, count, loading, error, retry }: Props) {
  const t = useT()
  const title = useTitle(query)
  const stats = useIndexStats()
  const pending = stats.data?.pending_count ?? 0
  // The backend answers 503 when CLIP is needed and not installed.
  const needClip = error instanceof ApiError && error.status === 503

  return (
    <div className={styles.banner} role="status" data-testid="similar-banner">
      <div className={styles.bannerMain}>
        <strong className={styles.bannerTitle} title={title}>
          {title}
        </strong>
        <span className={styles.bannerCount}>{loading ? t('sim.banner.searching') : error ? '' : t('sim.banner.count', { n: count })}</span>
        {pending > 0 && !error && (
          <span className={styles.bannerNote}>
            {t('sim.banner.pending', { n: pending })}
            <button type="button" className={styles.link} onClick={() => void withClip(() => void startIndexing())}>
              {t('sim.banner.buildIndex')}
            </button>
          </span>
        )}
        {error && needClip && (
          <span className={styles.bannerNote}>
            {t('sim.banner.needClip')}
            <button type="button" className={styles.link} onClick={() => void withClip(retry)}>
              {t('sim.banner.getClip')}
            </button>
          </span>
        )}
        {error && !needClip && (
          <span className={styles.bannerError}>
            {t('sim.banner.failed', { reason: error.message })}
            <button type="button" className={styles.link} onClick={retry}>
              {t('sim.banner.retry')}
            </button>
          </span>
        )}
      </div>
      <SearchTools query={query} />
      <button type="button" className="btn btn-ghost" onClick={() => useSimilar.getState().clear()} data-testid="similar-back">
        <Icon name="close" size={13} />
        {t('sim.banner.back')}
        <kbd>Esc</kbd>
      </button>
    </div>
  )
}
