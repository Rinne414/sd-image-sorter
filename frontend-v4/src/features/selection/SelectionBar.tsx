import { useEffect, useState } from 'react'
import { prefetchTagging } from '../../api/queries'
import type { ImageSummary } from '../../api/types'
import { useT } from '../../i18n'
import type { ImageQueryParams } from '../../lib/searchQuery'
import { useApp } from '../../state/store'
import { Icon } from '../../ui/Icon'
import { Menu, type MenuItem } from '../../ui/Menu'
import { useToasts } from '../../ui/toasts'
import { Stars } from '../card/Stars'
import { menuItemsOf, say, type ImageAction } from './actions'
import { useBulkActions } from './actionOps'
import { invertPicks, matchingIds } from './invert'
import styles from './SelectionBar.module.css'

interface Props {
  /** The gallery's current filter, used to pick every match on the server; null when the grid is not a filter (ranked by likeness). */
  params: ImageQueryParams | null
  total: number | null
  /** The total is the backend's estimate (lib/resultTotal.ts): said with "about". */
  about?: boolean
  images: ImageSummary[]
  hasMore: boolean
}

/** Docked under the grid while anything is picked: what can be done to the picks. */
export function SelectionBar({ params, total, about = false, images, hasMore }: Props) {
  const t = useT()
  const selection = useApp((s) => s.selection)
  const clear = useApp((s) => s.clearSelection)
  const actions = useBulkActions(selection)
  const [covered, setCovered] = useState<{ key: string; size: number } | null>(null)
  const [busy, setBusy] = useState<'all' | 'invert' | null>(null)
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
  const offerAll = params !== null && total !== null && total > 0 && !allMatchesPicked

  const selectAll = async () => {
    if (!params) return
    setBusy('all')
    try {
      const ids = await matchingIds(params)
      const s = useApp.getState()
      const have = new Set(s.selection)
      const next = [...s.selection, ...ids.filter((id) => !have.has(id))]
      s.setSelection(next)
      setCovered({ key, size: next.length })
    } catch (error) {
      useToasts.getState().push(t('sel.selectAllFailed', { reason: (error as Error).message }), 'error')
    } finally {
      setBusy(null)
    }
  }

  const invert = async () => {
    if (!params) return
    setBusy('invert')
    await invertPicks(params)
    setCovered(null)
    setBusy(null)
  }

  const main = actions.filter((a) => a.bar === 'main')
  const more = actions.filter((a) => a.bar === 'more')
  // A narrow bar (a small laptop with both side columns open) has no room for
  // Invert next to "select all": it moves to the top of More there.
  const invertItem: MenuItem = { id: 'invert', label: t('lib.sel.invert'), hint: 'Ctrl+I', onSelect: () => void invert(), className: styles.narrowOnly }
  const moreItems: MenuItem[] = [
    ...(params ? [invertItem] : []),
    ...menuItemsOf(t, more).map((item, i, items) => (item.danger && !items[i - 1]?.danger ? { ...item, divider: true } : item)),
  ]

  return (
    <div className={styles.bar} role="toolbar" aria-label={t('sel.count', { n: selection.length })} data-testid="selection-bar">
      <strong className={styles.count}>{t('sel.count', { n: selection.length })}</strong>
      {offerAll && (
        <button
          type="button"
          className={`btn btn-ghost ${styles.all}`}
          onClick={() => void selectAll()}
          disabled={busy !== null}
          title={t(about ? 'sel.selectAllAbout' : 'sel.selectAll', { n: total })}
          data-testid="select-all-matching"
        >
          {busy === 'all' ? (
            t('sel.selecting')
          ) : (
            <>
              <span className={styles.wordy}>{t(about ? 'sel.selectAllAbout' : 'sel.selectAll', { n: total })}</span>
              <span className={styles.terse}>{t(about ? 'sel.selectAllShortAbout' : 'sel.selectAllShort', { n: total })}</span>
            </>
          )}
        </button>
      )}
      {params && (
        <button
          type="button"
          className={`btn btn-ghost ${styles.all} ${styles.invert}`}
          onClick={() => void invert()}
          disabled={busy !== null}
          title={t('lib.sel.invertTitle')}
          data-testid="invert-picks"
        >
          {busy === 'invert' ? t('lib.sel.inverting') : t('lib.sel.invert')}
        </button>
      )}
      <span className={styles.rule} aria-hidden />
      {main.map((action) => (
        <BarAction key={action.id} action={action} />
      ))}
      <Menu up label={t('sel.more')} items={moreItems} />
      <span className={styles.spacer} />
      <button type="button" className="btn btn-ghost" onClick={clear} aria-label={t('sel.clear')} title={t('sel.clear')}>
        <span className={styles.wordy}>{t('sel.clear')}</span>
        <Icon name="close" size={13} className={styles.clearIcon} />
        <kbd className={styles.wordy}>Esc</kbd>
      </button>
    </div>
  )
}

/** One of the bar's up-front actions, drawn the way it reads best. */
function BarAction({ action }: { action: ImageAction }) {
  const t = useT()
  const label = say(t, action.label)
  if (action.id === 'batch') {
    return <Menu up primary label={label} items={menuItemsOf(t, action.children ?? [])} testId="add-to-batch" />
  }
  if (action.id === 'rate') {
    const byStars = new Map(action.children?.map((c) => [c.hint, c]))
    return (
      <span className={styles.stars} title={label} data-action="rate">
        <Stars value={0} onChange={(n) => n > 0 && byStars.get(String(n))?.run?.()} size="sm" />
      </span>
    )
  }
  if (action.id === 'favorite') {
    return (
      <button type="button" className="btn" onClick={action.run} aria-label={label} title={label} data-action="favorite">
        <Icon name="heart" size={14} />
        <span className={styles.wordy}>{label}</span>
      </button>
    )
  }
  const prefetch = action.id === 'tag' ? prefetchTagging : undefined
  return (
    <button type="button" className="btn" onClick={action.run} onPointerEnter={prefetch} onFocus={prefetch} data-action={action.id}>
      {label}
    </button>
  )
}
