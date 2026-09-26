import { useCallback, useMemo, useRef } from 'react'
import { useFavorites, useImageDetail, useSetRating, useToggleFavorite } from '../../api/queries'
import { useT } from '../../i18n'
import { useApp } from '../../state/store'
import { AddingBanner } from '../batch/AddingBanner'
import { GenerationCard } from '../card/GenerationCard'
import { SortNotice } from '../info/SortNotice'
import { Lightbox } from '../lightbox/Lightbox'
import { SelectionBar } from '../selection/SelectionBar'
import { SimilarBanner } from '../similar/SimilarBanner'
import { CardMenu } from './CardMenu'
import { EmptyResult } from './EmptyResult'
import { Gallery, type GalleryHandle } from './Gallery'
import styles from './LibraryPage.module.css'
import { libraryParams } from './params'
import { QueryBar } from './QueryBar'
import { Rail } from './Rail'
import { fetchImageAt } from './randomOpen'
import { useLibraryKeys } from './useLibraryKeys'
import { useShownImages } from './useShownImages'

export function LibraryPage() {
  const t = useT()
  const libraryId = useApp((s) => s.libraryId)
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
  const shown = useShownImages(params)
  const { images, total, similar } = shown
  // Come back to the same place for this search; a random order has no place.
  const scrollKey = similar || params.sort_by === 'random' ? undefined : shown.gridKey

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
    // Inverting works on the filter; while ranked by likeness there is none.
    params: similar ? null : params,
    gallery: galleryRef,
    search: inputRef,
    rate: (id, stars) => rate({ ids: [id], stars }),
    toggleFavorite: (id) => favorite({ ids: [id], favorited: !(favoriteIds?.has(id) ?? false) }),
  })
  const fetchAt = useCallback(async (offset: number) => (await fetchImageAt(params, offset)).image, [params])

  return (
    <div className={styles.page} data-card={cardOpen || undefined} data-rail={railOpen || undefined}>
      {railOpen && <Rail texture={texture} />}
      <main className={styles.main}>
        <QueryBar total={total} inputRef={inputRef} />
        {adding && <AddingBanner target={adding} />}
        {!similar && <SortNotice params={params} />}
        {similar && <SimilarBanner query={similar} count={images.length} loading={shown.loading} error={shown.error} retry={shown.retry} />}
        <div className={styles.gridArea}>
          {!similar && shown.error ? (
            <div className={styles.notice}>
              <p>{t('grid.error', { reason: shown.error.message })}</p>
              <button type="button" className="btn" onClick={shown.retry}>
                {t('grid.retry')}
              </button>
            </div>
          ) : similar && shown.empty ? (
            <div className={styles.notice}>
              <p>{t('sim.banner.empty')}</p>
            </div>
          ) : shown.empty ? (
            <EmptyResult params={params} />
          ) : (
            <Gallery
              // another library with the same search is another grid (its own scroll place)
              key={`${libraryId}|${shown.gridKey}`}
              images={images}
              total={total}
              scrollKey={scrollKey}
              hasMore={shown.hasMore}
              isFetchingMore={shown.fetchingMore}
              fetchMore={shown.fetchMore}
              favorites={favoriteIds ?? new Set()}
              onFavorite={onFavorite}
              onReady={onReady}
              stale={shown.stale}
              scores={shown.scores}
            />
          )}
          {selection.length > 0 && (
            <SelectionBar params={similar ? null : params} total={total} images={images} hasMore={shown.hasMore} />
          )}
        </div>
      </main>
      {cardOpen && <GenerationCard id={inspectedId} />}
      <Lightbox
        images={images}
        total={total ?? images.length}
        hasMore={shown.hasMore}
        fetchMore={shown.fetchMore}
        {...(similar ? {} : { fetchAt })}
      />
      <CardMenu />
    </div>
  )
}
