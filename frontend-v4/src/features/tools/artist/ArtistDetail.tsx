import { thumbnailUrl } from '../../../api/client'
import { PREVIEW_PAGE, useArtistImages, useArtistStats } from './artistApi'
import styles from './Artist.module.css'
import { artistName, percent } from './artistSummary'
import { useAT } from './artistText'
import { useArtistView, viewInLibrary } from './artistView'
import type { ArtistImage } from './types'

// One artist: how many images and how sure, the way into the library search
// (artist:NAME), and the images most confident first, a page at a time. A
// preview opens that image in the library, where every image action is.

function Preview({ image, name }: { image: ArtistImage; name: string }) {
  const t = useAT()
  const tier = image.confidence_level === 'high' ? null : image.confidence_level === 'low' ? t('artist.detail.tier.low') : t('artist.detail.tier.none')
  return (
    <li>
      <button
        type="button"
        className={styles.preview}
        onClick={() => viewInLibrary(name, image.image_id)}
        title={t('artist.detail.open', { name: image.filename })}
        data-testid="artist-preview"
        data-id={image.image_id}
      >
        <span className={styles.thumb}>
          <img src={thumbnailUrl(image.image_id, 256)} alt="" loading="lazy" draggable={false} />
          <span className={`${styles.pct} mono`}>{percent(image.confidence)}</span>
          {tier && <span className={styles.tier}>{tier}</span>}
        </span>
        <span className={styles.fileName}>{image.filename}</span>
      </button>
    </li>
  )
}

function Previews({ name }: { name: string }) {
  const t = useAT()
  const pages = useArtistImages(name)
  if (pages.isError) return <p className={styles.problem}>{t('artist.detail.loadFailed', { reason: pages.error.message })}</p>
  const images = pages.data?.pages.flatMap((p) => p.images) ?? []
  const total = pages.data?.pages[0]?.total ?? 0
  const left = Math.max(0, total - images.length)
  return (
    <>
      <ul className={styles.previews} data-testid="artist-previews">
        {images.map((image) => (
          <Preview key={image.image_id} image={image} name={name} />
        ))}
      </ul>
      {total > 0 && (
        <div className={styles.moreRow}>
          <span className="mono" data-testid="artist-shown">
            {t('artist.detail.shown', { shown: images.length, total })}
          </span>
          {pages.hasNextPage && (
            <button type="button" className="btn" onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage} data-testid="artist-more">
              {t('artist.detail.more', { n: Math.min(PREVIEW_PAGE, left) })}
            </button>
          )}
        </div>
      )}
    </>
  )
}

export function ArtistDetail() {
  const t = useAT()
  const name = useArtistView((s) => s.selected)
  const stats = useArtistStats().data
  if (!name) {
    return (
      <section className={styles.detailCol} data-testid="artist-detail">
        <p className={styles.empty}>{t('artist.detail.pick')}</p>
      </section>
    )
  }
  const confident = stats?.artist_counts?.[name] ?? 0
  const candidate = stats?.low_confidence_artist_counts?.[name] ?? 0
  const candidateOnly = confident === 0 && candidate > 0
  const detail = stats?.artist_stats?.[name]
  return (
    <section className={styles.detailCol} data-testid="artist-detail" data-artist={name}>
      <div className={styles.detailScroll}>
        <div className={styles.detailHead}>
          <h2 className={styles.detailName}>{artistName(name)}</h2>
          {candidateOnly && <span className={styles.badge}>{t('artist.detail.candidateBadge')}</span>}
          <button type="button" className="btn btn-primary" onClick={() => viewInLibrary(name)} title={t('artist.detail.viewHint', { name })} data-testid="artist-view">
            {t('artist.detail.view')}
          </button>
        </div>
        <p className={styles.detailFacts}>
          {candidateOnly ? t('artist.detail.candidate', { n: candidate }) : t('artist.detail.confident', { n: confident })}
          {detail && ` · ${t('artist.detail.confidence', { avg: percent(detail.avg_confidence), peak: percent(detail.max_confidence) })}`}
        </p>
        {candidateOnly && <p className={styles.note}>{t('artist.candidates.hint')}</p>}
        <Previews key={name} name={name} />
      </div>
    </section>
  )
}
