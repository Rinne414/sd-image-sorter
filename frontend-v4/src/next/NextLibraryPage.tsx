import { useCallback, useMemo, useRef } from 'react'
import { useFavorites, useSetRating, useToggleFavorite } from '../api/queries'
import { useT } from '../i18n'
import { useApp } from '../state/store'
import { AddingBanner } from '../features/batch/AddingBanner'
import { GenerationCard } from '../features/card/GenerationCard'
import { useCollectPaste } from '../features/collect/useCollectPaste'
import { SortNotice } from '../features/info/SortNotice'
import { CardMenu } from '../features/library/CardMenu'
import { EmptyResult } from '../features/library/EmptyResult'
import { Gallery, type GalleryHandle } from '../features/library/Gallery'
import { libraryParams } from '../features/library/params'
import { fetchImageAt } from '../features/library/randomOpen'
import { useLibraryKeys } from '../features/library/useLibraryKeys'
import { useShownImages } from '../features/library/useShownImages'
import { Lightbox } from '../features/lightbox/Lightbox'
import { SelectionBar } from '../features/selection/SelectionBar'
import { SimilarBanner } from '../features/similar/SimilarBanner'
import { LibraryFooter } from './LibraryFooter'
import styles from './NextLibraryPage.module.css'
import { withPromptWord } from './promptWord'
import { ScopeLine } from './ScopeLine'

/** Grid cells are portrait: most generated images are 2:3, so a square cell cuts heads and feet. */
const GRID_RATIO = 1.4
const TILE_GAP = 10

/**
 * The library in the new interface (docs/DESIGN.md §redesign-2026-10,
 * direction A): the scope line, the images on the rest of the screen, a
 * recipe column only while an image is inspected, the action bar while
 * images are picked, and the footer line.
 */
export function NextLibraryPage() {
  const t = useT()
  const libraryId = useApp((s) => s.libraryId)
  const queryText = useApp((s) => s.queryText)
  const scope = useApp((s) => s.scope)
  const sort = useApp((s) => s.sort)
  const sortReverse = useApp((s) => s.sortReverse)
  const cardOpen = useApp((s) => s.cardOpen)
  const inspectedId = useApp((s) => s.inspectedId)
  const selection = useApp((s) => s.selection)
  const adding = useApp((s) => s.adding)
  const favorites = useFavorites()
  const setRating = useSetRating()
  const toggleFav = useToggleFavorite()
  useCollectPaste()

  const favoritesCollectionId = favorites.data?.collectionId ?? null
  const params = useMemo(
    () => libraryParams({ queryText, scope, sort, sortReverse, favoritesCollectionId }),
    [queryText, scope, sort, sortReverse, favoritesCollectionId],
  )
  const shown = useShownImages(params)
  const { images, total, similar } = shown
  const scrollKey = similar || params.sort_by === 'random' ? undefined : shown.gridKey

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
    params: similar ? null : params,
    gallery: galleryRef,
    search: inputRef,
    rate: (id, stars) => rate({ ids: [id], stars }),
    toggleFavorite: (id) => favorite({ ids: [id], favorited: !(favoriteIds?.has(id) ?? false) }),
    escapeClearsInspect: true,
  })
  const fetchAt = useCallback(async (offset: number) => (await fetchImageAt(params, offset)).image, [params])
  const addWord = useCallback((word: string) => {
    const s = useApp.getState()
    s.setQueryText(withPromptWord(s.queryText, word))
  }, [])

  // The recipe column only while an image is inspected: never an empty column.
  const showCard = cardOpen && inspectedId !== null

  return (
    <div className={styles.page} data-card={showCard || undefined}>
      <main className={styles.main}>
        <ScopeLine total={total} about={shown.totalAbout} inputRef={inputRef} />
        {adding && <AddingBanner target={adding} />}
        {!similar && <SortNotice params={params} found={!shown.loading && !shown.empty && !shown.error} />}
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
              look="plain"
              gridRatio={GRID_RATIO}
              gap={TILE_GAP}
            />
          )}
          {selection.length > 0 && (
            <SelectionBar params={similar ? null : params} total={total} about={shown.totalAbout} images={images} hasMore={shown.hasMore} />
          )}
        </div>
        <LibraryFooter />
      </main>
      {showCard && <GenerationCard id={inspectedId} look="plain" onWord={addWord} />}
      <Lightbox
        images={images}
        total={total ?? images.length}
        totalAbout={shown.totalAbout}
        hasMore={shown.hasMore}
        fetchMore={shown.fetchMore}
        {...(similar ? {} : { fetchAt })}
      />
      <CardMenu />
    </div>
  )
}
