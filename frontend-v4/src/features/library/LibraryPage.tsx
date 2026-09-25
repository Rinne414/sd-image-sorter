import { useCallback, useMemo, useRef } from 'react'
import { useFavorites, useImageDetail, useImages, useSetRating, useToggleFavorite } from '../../api/queries'
import { useT } from '../../i18n'
import { useApp } from '../../state/store'
import { AddingBanner } from '../batch/AddingBanner'
import { GenerationCard } from '../card/GenerationCard'
import { Lightbox } from '../lightbox/Lightbox'
import { SelectionBar } from '../selection/SelectionBar'
import { startColorAnalysis, useColorsMissing } from '../status/colorAnalysis'
import { CardMenu } from './CardMenu'
import { Gallery, type GalleryHandle } from './Gallery'
import styles from './LibraryPage.module.css'
import { libraryParams } from './params'
import { QueryBar } from './QueryBar'
import { Rail } from './Rail'
import { fetchImageAt } from './randomOpen'
import { useLibraryKeys } from './useLibraryKeys'

export function LibraryPage() {
  const t = useT()
  const queryText = useApp((s) => s.queryText)
  const scope = useApp((s) => s.scope)
  const sort = useApp((s) => s.sort)
  const sortReverse = useApp((s) => s.sortReverse)
  const cardOpen = useApp((s) => s.cardOpen)
  const railOpen = useApp((s) => s.railOpen)
  const inspectedId = useApp((s) => s.inspectedId)
  const selection = useApp((s) => s.selection)
  const adding = useApp((s) => s.adding)
  const favorites = useFavorites()
  const setRating = useSetRating()
  const toggleFav = useToggleFavorite()

  const favoritesCollectionId = favorites.data?.collectionId ?? null
  const params = useMemo(
    () => libraryParams({ queryText, scope, sort, sortReverse, favoritesCollectionId }),
    [queryText, scope, sort, sortReverse, favoritesCollectionId],
  )
  const query = useImages(params)
  const colors = useColorsMissing()
  const images = useMemo(() => query.data?.pages.flatMap((p) => p.images) ?? [], [query.data])
  const total = query.data?.pages[0]?.total ?? null
  const fetchMore = useCallback(() => void query.fetchNextPage(), [query])

  const first = images[0]
  const textureDetail = useImageDetail(inspectedId ?? first?.id ?? null)
  const texture = (textureDetail.data?.image.prompt ?? '').repeat(3)

  const galleryRef = useRef<GalleryHandle | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const onReady = useCallback((h: GalleryHandle) => {
    galleryRef.current = h
  }, [])

  const favoriteIds = favorites.data?.ids
  const rate = setRating.mutate
  const favorite = toggleFav.mutate
  const onFavorite = useCallback((id: number, on: boolean) => favorite({ ids: [id], favorited: on }), [favorite])
  useLibraryKeys({
    images,
    params,
    gallery: galleryRef,
    search: inputRef,
    rate: (id, stars) => rate({ ids: [id], stars }),
    toggleFavorite: (id) => favorite({ ids: [id], favorited: !(favoriteIds?.has(id) ?? false) }),
  })
  const fetchAt = useCallback(async (offset: number) => (await fetchImageAt(params, offset)).image, [params])

  const gridKey = JSON.stringify(params)

  return (
    <div className={styles.page} data-card={cardOpen || undefined} data-rail={railOpen || undefined}>
      {railOpen && <Rail texture={texture} />}
      <main className={styles.main}>
        <QueryBar total={total} inputRef={inputRef} />
        {adding && <AddingBanner target={adding} />}
        <div className={styles.gridArea}>
          {query.isError ? (
            <div className={styles.notice}>
              <p>{t('grid.error', { reason: query.error.message })}</p>
              <button type="button" className="btn" onClick={() => void query.refetch()}>
                {t('grid.retry')}
              </button>
            </div>
          ) : query.isSuccess && images.length === 0 ? (
            <div className={styles.notice}>
              <p className={styles.noticeTitle}>{t('grid.empty')}</p>
              {usesColorData(params) && (colors.data?.missing ?? 0) > 0 ? (
                <>
                  <p data-testid="color-hint">{t('status.colorHint', { n: colors.data?.missing ?? 0 })}</p>
                  <button type="button" className="btn" onClick={() => void startColorAnalysis()}>
                    {t('status.colorHintAction')}
                  </button>
                </>
              ) : (
                <p>{t('grid.emptyHint')}</p>
              )}
            </div>
          ) : (
            <Gallery
              key={gridKey}
              images={images}
              hasMore={query.hasNextPage}
              isFetchingMore={query.isFetchingNextPage}
              fetchMore={fetchMore}
              favorites={favoriteIds ?? new Set()}
              onFavorite={onFavorite}
              onReady={onReady}
              stale={query.isPlaceholderData}
            />
          )}
          {selection.length > 0 && (
            <SelectionBar params={params} total={total} images={images} hasMore={query.hasNextPage} />
          )}
        </div>
      </main>
      {cardOpen && <GenerationCard id={inspectedId} />}
      <Lightbox images={images} total={total ?? images.length} hasMore={query.hasNextPage} fetchMore={fetchMore} fetchAt={fetchAt} />
      <CardMenu />
    </div>
  )
}

/** Filters that only see images with colour analysis. */
const COLOR_KEYS = [
  'color_hues',
  'exclude_color_hues',
  'exclude_colors',
  'color_temperature',
  'brightness_distribution',
  'brightness_min',
  'brightness_max',
  'min_saturation',
  'max_saturation',
]

function usesColorData(params: Record<string, unknown>): boolean {
  return COLOR_KEYS.some((k) => k in params)
}
