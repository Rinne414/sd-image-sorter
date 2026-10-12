import { useArtistStats } from './artistApi'
import styles from './Artist.module.css'
import { useAT, type ArtistKey } from './artistText'
import type { ArtistStats } from './types'

// The five numbers of the library on screen. The three result buckets never
// overlap: confident + unconfirmed + no match = images with a result.

const CELLS: { key: ArtistKey; id: string; value: (s: ArtistStats) => number }[] = [
  { key: 'artist.stat.total', id: 'total', value: (s) => s.total_images },
  { key: 'artist.stat.confident', id: 'confident', value: (s) => s.confident_count ?? 0 },
  { key: 'artist.stat.unconfirmed', id: 'unconfirmed', value: (s) => s.low_confidence_count ?? 0 },
  { key: 'artist.stat.none', id: 'none', value: (s) => s.undefined_count },
  { key: 'artist.stat.artists', id: 'artists', value: (s) => Object.keys(s.artist_counts ?? {}).length },
]

export function StatsBar() {
  const t = useAT()
  const stats = useArtistStats()
  if (stats.isError) return <p className={styles.problem}>{t('artist.stat.loadFailed', { reason: stats.error.message })}</p>
  return (
    <div className={styles.stats} data-testid="artist-stats">
      {CELLS.map((c) => (
        <div key={c.id} className={styles.stat} data-testid={`artist-stat-${c.id}`}>
          <span className={`${styles.statValue} mono`}>{stats.data ? c.value(stats.data).toLocaleString() : '…'}</span>
          <span className={styles.statLabel}>{t(c.key)}</span>
        </div>
      ))}
    </div>
  )
}
