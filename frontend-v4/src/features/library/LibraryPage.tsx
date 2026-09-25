import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useFavorites, useImageDetail, useImages, useSetRating, useToggleFavorite } from '../../api/queries'
import { useT } from '../../i18n'
import { isTypingTarget } from '../../lib/format'
import { parseSearch, toImageParams } from '../../lib/searchQuery'
import { apiSort } from '../../lib/sort'
import { useApp } from '../../state/store'
import { GenerationCard } from '../card/GenerationCard'
import { Lightbox } from '../lightbox/Lightbox'
import { useSelectionDialog } from '../selection/dialogs'
import { SelectionBar } from '../selection/SelectionBar'
import { Gallery, type GalleryHandle } from './Gallery'
import styles from './LibraryPage.module.css'
import { QueryBar } from './QueryBar'
import { Rail } from './Rail'
import { layerCount } from '../../ui/layers'

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
  const favorites = useFavorites()
  const setRating = useSetRating()
  const toggleFav = useToggleFavorite()

  const params = useMemo(
    () =>
      toImageParams(
        parseSearch(queryText),
        {
          generators: scope.generators,
          folder: scope.folder,
          favoritesCollectionId: scope.favorites ? (favorites.data?.collectionId ?? null) : null,
        },
        apiSort(sort, sortReverse),
      ),
    [queryText, scope, sort, sortReverse, favorites.data?.collectionId],
  )
  const query = useImages(params)
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

  // Grid keys. The lightbox and the palette take over while they are open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState()
      // Anything floating (lightbox, palette, a menu) owns the keyboard.
      if (layerCount() > 0 || s.page !== 'library') return
      if (isTypingTarget(e.target)) return
      const g = galleryRef.current
      const id = s.inspectedId
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey
      let handled = true
      switch (e.key) {
        case 'ArrowLeft':
          g?.move('left')
          break
        case 'ArrowRight':
          g?.move('right')
          break
        case 'ArrowUp':
          g?.move('up')
          break
        case 'ArrowDown':
          g?.move('down')
          break
        case 'Home':
          g?.move('first')
          break
        case 'End':
          g?.move('last')
          break
        case 'Enter':
          if (id !== null) s.openLightbox(id)
          break
        case ' ':
          if (id !== null) s.togglePick(id)
          break
        case 'Escape':
          if (s.selection.length) s.clearSelection()
          else handled = false
          break
        case '/':
          inputRef.current?.focus()
          break
        case 'Delete':
          if (s.selection.length) useSelectionDialog.getState().show('remove')
          else handled = false
          break
        default:
          handled = false
      }
      if (!handled && plain && /^[0-5]$/.test(e.key) && id !== null) {
        setRating.mutate({ ids: [id], stars: Number(e.key) })
        handled = true
      } else if (!handled && plain && (e.key === 'f' || e.key === 'F') && id !== null) {
        toggleFav.mutate({ ids: [id], favorited: !(favorites.data?.ids.has(id) ?? false) })
        handled = true
      } else if (!handled && plain && (e.key === 'i' || e.key === 'I')) {
        s.toggleCard()
        handled = true
      } else if (!handled && (e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        s.setSelection(images.map((img) => img.id))
        handled = true
      }
      if (handled) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [images, favorites.data, setRating, toggleFav])

  const gridKey = JSON.stringify(params)

  return (
    <div className={styles.page} data-card={cardOpen || undefined} data-rail={railOpen || undefined}>
      {railOpen && <Rail texture={texture} />}
      <main className={styles.main}>
        <QueryBar total={total} inputRef={inputRef} />
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
              <p>{t('grid.emptyHint')}</p>
            </div>
          ) : (
            <Gallery
              key={gridKey}
              images={images}
              hasMore={query.hasNextPage}
              isFetchingMore={query.isFetchingNextPage}
              fetchMore={fetchMore}
              favorites={favorites.data?.ids ?? new Set()}
              onReady={onReady}
              stale={query.isPlaceholderData}
            />
          )}
          {selection.length > 0 && (
            <SelectionBar
              params={params}
              total={total}
              images={images}
              hasMore={query.hasNextPage}
              onRate={(n) => setRating.mutate({ ids: selection, stars: n })}
              onFavorite={() => toggleFav.mutate({ ids: selection, favorited: true })}
            />
          )}
        </div>
      </main>
      {cardOpen && <GenerationCard id={inspectedId} />}
      <Lightbox images={images} total={total ?? images.length} hasMore={query.hasNextPage} fetchMore={fetchMore} />
    </div>
  )
}
