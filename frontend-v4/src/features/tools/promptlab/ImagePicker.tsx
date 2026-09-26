import { useEffect, useMemo, useRef, useState } from 'react'
import { useImages } from '../../../api/queries'
import { thumbnailUrl } from '../../../api/urls'
import { parseSearch, toImageParams } from '../../../lib/searchQuery'
import { apiSort } from '../../../lib/sort'
import { useApp } from '../../../state/store'
import { Dialog } from '../../../ui/Dialog'
import { usePL } from './plText'
import styles from './PromptLab.module.css'

// Choose one library image for Compare or Build. It searches the whole
// library with the library's own search words and loads more as it scrolls:
// no "newest 200" window, so any image can be picked (V3.5 pain point 3).

const NO_SCOPE = { generators: [], folder: null, favoritesCollectionId: null }

interface Props {
  title: string
  onPick: (id: number) => void
  onClose: () => void
}

function useMoreOnSight(more: () => void, active: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !active) return
    const seen = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && more(), { rootMargin: '240px' })
    seen.observe(el)
    return () => seen.disconnect()
  }, [more, active])
  return ref
}

export function ImagePicker({ title, onPick, onClose }: Props) {
  const t = usePL()
  const [text, setText] = useState(() => useApp.getState().queryText)
  const [query, setQuery] = useState(text)
  // Search a moment after typing stops, not on every key.
  useEffect(() => {
    const id = window.setTimeout(() => setQuery(text), 250)
    return () => window.clearTimeout(id)
  }, [text])
  const params = useMemo(() => toImageParams(parseSearch(query), NO_SCOPE, apiSort('newest', false)), [query])
  const images = useImages(params)
  const list = images.data?.pages.flatMap((p) => p.images) ?? []
  const total = images.data?.pages[0]?.total ?? null
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = images
  const more = useMemo(() => () => void fetchNextPage(), [fetchNextPage])
  const sentinel = useMoreOnSight(more, !!hasNextPage && !isFetchingNextPage)

  return (
    <Dialog title={title} onClose={onClose} wide="x" testId="pl-picker">
      <div className={styles.pickerBar}>
        <input
          className={styles.input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && setQuery(text)}
          placeholder={t('pl.pick.search')}
          aria-label={t('pl.pick.search')}
          spellCheck={false}
          data-testid="pl-picker-search"
        />
        {total !== null && total >= 0 && <span className={`${styles.muted} mono`}>{t('pl.pick.count', { n: total })}</span>}
      </div>
      {images.isError && <p className={styles.problem}>{t('pl.pick.failed', { reason: images.error.message })}</p>}
      {images.isPending && <p className={styles.muted}>{t('pl.pick.loading')}</p>}
      {images.isSuccess && list.length === 0 && <p className={styles.muted}>{t('pl.pick.none')}</p>}
      <ul className={styles.pickerGrid} aria-busy={images.isFetching || undefined}>
        {list.map((img) => (
          <li key={img.id}>
            <button type="button" className={styles.pickTile} onClick={() => onPick(img.id)} title={img.filename} data-id={img.id}>
              <img src={thumbnailUrl(img.id, 256)} alt="" loading="lazy" />
              <span className={styles.pickName}>{img.filename}</span>
            </button>
          </li>
        ))}
      </ul>
      <div ref={sentinel} className={styles.sentinel} aria-hidden />
      {isFetchingNextPage && <p className={styles.muted}>{t('pl.pick.loading')}</p>}
    </Dialog>
  )
}
