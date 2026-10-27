import { useState } from 'react'
import { useT } from '../../i18n'
import { Icon } from '../../ui/Icon'
import { Menu } from '../../ui/Menu'
import { useToasts } from '../../ui/toasts'
import { quickCensor } from '../censor/quickCensor'
import { tr } from '../jobs/jobs'
import { showPinned } from '../library/pinnedSet'
import { useBulkActions } from '../selection/actionOps'
import { menuItemsOf, type ImageAction } from '../selection/actions'
import styles from './MapCanvas.module.css'
import { clearPicks, usePicks } from './pickStore'

const NO_IDS: number[] = []

/**
 * The picked dots' pictures, and where they can go: a batch (new, from a
 * template, or a recent one: the library's own batch menu), Censor (GIFs and
 * videos go to their own censor), a new dataset batch, the library as
 * exactly these pictures, or nowhere (clear). Each target is the one the
 * library uses, never a copy.
 */
export function PicksBar() {
  const t = useT()
  const picked = usePicks((s) => s.picked)
  const status = usePicks((s) => s.status)
  const ready = usePicks((s) => (s.status === 'ready' ? s.ids : NO_IDS))
  const actions = useBulkActions(ready)
  const [busy, setBusy] = useState(false)
  if (picked.size === 0) return null

  const batch = actions.find((a) => a.id === 'batch')
  const children = batch?.children ?? []
  const dataset = children.find((a: ImageAction) => a.id === 'batch-new-dataset')
  const waiting = status !== 'ready' || ready.length === 0 || busy

  const toLibrary = async () => {
    setBusy(true)
    try {
      const shown = await showPinned(ready)
      if (shown === 0) useToasts.getState().push(tr('stylemap.sel.gone'), 'info')
    } catch (error) {
      useToasts.getState().push(tr('error.generic', { reason: (error as Error).message }), 'error')
    } finally {
      setBusy(false)
    }
  }

  const toCensor = async () => {
    setBusy(true)
    try {
      await quickCensor(ready)
    } catch (error) {
      useToasts.getState().push(tr('error.generic', { reason: (error as Error).message }), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.picks} role="toolbar" aria-label={t('stylemap.sel.label')} data-testid="stylemap-selbar">
      <span className={styles.picksCount} role="status" data-testid="stylemap-selbar-count" data-count={status === 'ready' ? ready.length : undefined}>
        {status === 'ready' ? t('sel.count', { n: ready.length }) : t('stylemap.sel.counting')}
      </span>
      {waiting ? (
        <button type="button" className="btn" disabled data-testid="stylemap-sel-batch">
          {t('batch.menu.label')}
          <Icon name="caret" size={13} />
        </button>
      ) : (
        <Menu label={t('batch.menu.label')} items={menuItemsOf(t, children)} up testId="stylemap-sel-batch" />
      )}
      <button type="button" className="btn" disabled={waiting} onClick={() => void toCensor()} data-testid="stylemap-sel-censor">
        {t('sel.censor')}
      </button>
      <button type="button" className="btn" disabled={waiting || !dataset} onClick={() => dataset?.run?.()} title={t('stylemap.sel.datasetTip')} data-testid="stylemap-sel-dataset">
        {t('stylemap.sel.dataset')}
      </button>
      <button type="button" className="btn" disabled={waiting} onClick={() => void toLibrary()} title={t('stylemap.sel.libraryTip')} data-testid="stylemap-sel-library">
        {t('stylemap.sel.library')}
      </button>
      <button type="button" className="btn btn-ghost" onClick={clearPicks} title={t('stylemap.sel.clearTip')} data-testid="stylemap-sel-clear">
        <Icon name="close" size={12} />
        {t('sel.clear')}
        <kbd>Esc</kbd>
      </button>
    </div>
  )
}
