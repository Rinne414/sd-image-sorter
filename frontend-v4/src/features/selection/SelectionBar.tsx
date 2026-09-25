import { useEffect, useState } from 'react'
import { api, unwrap } from '../../api/client'
import { prefetchTagging } from '../../api/queries'
import type { components } from '../../api/schema'
import type { ImageSummary } from '../../api/types'
import { useT } from '../../i18n'
import type { ImageQueryParams } from '../../lib/searchQuery'
import { toSelectionBody } from '../../lib/selectionBody'
import { useApp } from '../../state/store'
import { Icon } from '../../ui/Icon'
import { Menu } from '../../ui/Menu'
import { useToasts } from '../../ui/toasts'
import { Stars } from '../card/Stars'
import { AddToBatchMenu } from '../batch/AddToBatchMenu'
import { useSelectionDialog } from './dialogs'
import styles from './SelectionBar.module.css'

type SelectionIdsBody = components['schemas']['SelectionIdsRequest']

interface Props {
  /** The gallery's current filter, used to pick every match on the server. */
  params: ImageQueryParams
  total: number | null
  images: ImageSummary[]
  hasMore: boolean
  onRate: (stars: number) => void
  onFavorite: () => void
}

/** Docked under the grid while anything is picked: what can be done to the picks. */
export function SelectionBar({ params, total, images, hasMore, onRate, onFavorite }: Props) {
  const t = useT()
  const selection = useApp((s) => s.selection)
  const clear = useApp((s) => s.clearSelection)
  const show = useSelectionDialog((s) => s.show)
  const [covered, setCovered] = useState<{ key: string; size: number } | null>(null)
  const [selecting, setSelecting] = useState(false)
  const key = JSON.stringify(params)

  // Toasts sit above the bar instead of on top of it.
  useEffect(() => {
    document.documentElement.dataset.selbar = ''
    return () => {
      delete document.documentElement.dataset.selbar
    }
  }, [])

  const picked = new Set(selection)
  const everyLoadedPicked = images.length > 0 && images.every((img) => picked.has(img.id))
  const allMatchesPicked = (covered?.key === key && selection.length >= covered.size) || (!hasMore && everyLoadedPicked)
  const offerAll = total !== null && total > 0 && !allMatchesPicked

  const selectAll = async () => {
    setSelecting(true)
    try {
      // Filters left out of the body take the server's defaults, same as the gallery list.
      const body = toSelectionBody(params) as unknown as SelectionIdsBody
      const res = unwrap<{ image_ids: number[] }>(await api.POST('/api/images/selection-ids', { body }))
      const s = useApp.getState()
      const have = new Set(s.selection)
      const next = [...s.selection, ...res.image_ids.filter((id) => !have.has(id))]
      s.setSelection(next)
      setCovered({ key, size: next.length })
    } catch (error) {
      useToasts.getState().push(t('sel.selectAllFailed', { reason: (error as Error).message }), 'error')
    } finally {
      setSelecting(false)
    }
  }

  return (
    <div className={styles.bar} role="toolbar" aria-label={t('sel.count', { n: selection.length })} data-testid="selection-bar">
      <strong className={styles.count}>{t('sel.count', { n: selection.length })}</strong>
      {offerAll && (
        <button
          type="button"
          className={`btn btn-ghost ${styles.all}`}
          onClick={() => void selectAll()}
          disabled={selecting}
          title={t('sel.selectAll', { n: total })}
          data-testid="select-all-matching"
        >
          {selecting ? (
            t('sel.selecting')
          ) : (
            <>
              <span className={styles.wordy}>{t('sel.selectAll', { n: total })}</span>
              <span className={styles.terse}>{t('sel.selectAllShort', { n: total })}</span>
            </>
          )}
        </button>
      )}
      <span className={styles.rule} aria-hidden />
      <AddToBatchMenu />
      <span className={styles.stars} title={t('sel.rate')}>
        <Stars value={0} onChange={(n) => n > 0 && onRate(n)} size="sm" />
      </span>
      <button type="button" className="btn" onClick={onFavorite} aria-label={t('sel.favorite')} title={t('sel.favorite')}>
        <Icon name="heart" size={14} />
        <span className={styles.wordy}>{t('sel.favorite')}</span>
      </button>
      <button type="button" className="btn" onClick={() => show('tag')} onPointerEnter={prefetchTagging} onFocus={prefetchTagging}>
        {t('sel.tag')}
      </button>
      <button type="button" className="btn" onClick={() => show('move')}>
        {t('sel.move')}
      </button>
      <Menu
        up
        label={t('sel.more')}
        items={[
          { id: 'copy', label: t('sel.copy'), onSelect: () => show('copy') },
          { id: 'edit-tags', label: t('sel.editTags'), onSelect: () => show('edit-tags') },
          { id: 'export', label: t('sel.exportData'), onSelect: () => show('export') },
          { id: 'move-library', label: t('sel.moveLibrary'), onSelect: () => show('move-library') },
          { id: 'remove', label: t('sel.remove'), hint: 'Del', danger: true, divider: true, onSelect: () => show('remove') },
          { id: 'trash', label: t('sel.trash'), danger: true, onSelect: () => show('trash') },
        ]}
      />
      <span className={styles.spacer} />
      <button type="button" className="btn btn-ghost" onClick={clear} aria-label={t('sel.clear')} title={t('sel.clear')}>
        <span className={styles.wordy}>{t('sel.clear')}</span>
        <Icon name="close" size={13} className={styles.clearIcon} />
        <kbd className={styles.wordy}>Esc</kbd>
      </button>
    </div>
  )
}
