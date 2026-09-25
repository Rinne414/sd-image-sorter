import { useState } from 'react'
import { useT } from '../../i18n'
import { useApp, type AddTarget } from '../../state/store'
import { useBatch } from './batchApi'
import { addLibraryPicks } from './datasetApi'
import { askNewBatch } from './dialogStore'
import styles from './AddingBanner.module.css'
import { kindLabel } from './labels'

/** Over the library while picking for a batch: one click puts the picks in and goes back. */
export function AddingBanner({ target }: { target: AddTarget }) {
  return 'batchId' in target ? <ForExisting batchId={target.batchId} /> : <ForNew kind={target.kind} />
}

function ForExisting({ batchId }: { batchId: number }) {
  const t = useT()
  const batch = useBatch(batchId)
  const selection = useApp((s) => s.selection)
  const [busy, setBusy] = useState(false)
  const name = batch.data?.name ?? ''
  const n = selection.length

  const add = async () => {
    if (!batch.data) return
    setBusy(true)
    const res = await addLibraryPicks(batch.data, selection)
    setBusy(false)
    if (!res) return
    const s = useApp.getState()
    s.clearSelection()
    s.setAdding(null)
    s.openBatch(batchId)
  }

  const back = () => {
    const s = useApp.getState()
    s.setAdding(null)
    s.openBatch(batchId)
  }

  return (
    <div className={styles.banner} role="region" aria-label={t('batch.adding.to', { name })} data-testid="adding-banner">
      <span className={styles.text}>
        <strong>{t('batch.adding.to', { name })}</strong>
        <span className={styles.hint}>{t('batch.adding.hint')}</span>
      </span>
      <button type="button" className="btn btn-primary" onClick={() => void add()} disabled={n === 0 || busy || !batch.data} data-testid="adding-add">
        {t('batch.adding.add', { n })}
      </button>
      <button type="button" className="btn btn-ghost" onClick={back}>
        {t('batch.adding.back')}
      </button>
    </div>
  )
}

function ForNew({ kind }: { kind: 'pixiv' | 'dataset' | 'custom' }) {
  const t = useT()
  const selection = useApp((s) => s.selection)
  const n = selection.length
  const label = kindLabel(kind, t)

  return (
    <div className={styles.banner} role="region" aria-label={t('batch.adding.forNew', { kind: label })} data-testid="adding-banner">
      <span className={styles.text}>
        <strong>{t('batch.adding.forNew', { kind: label })}</strong>
        <span className={styles.hint}>{t('batch.adding.hint')}</span>
      </span>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => askNewBatch(kind, useApp.getState().selection, 'adding')}
        disabled={n === 0}
        data-testid="adding-add"
      >
        {t('batch.adding.make', { n, kind: label })}
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => useApp.getState().setAdding(null)}>
        {t('common.cancel')}
      </button>
    </div>
  )
}
