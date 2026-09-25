import { lazy, Suspense, useState } from 'react'
import { ApiError } from '../../api/client'
import type { Batch } from '../../api/types'
import { useT } from '../../i18n'
import { useApp } from '../../state/store'
import { Icon } from '../../ui/Icon'
import { patchBatch, useBatch } from './batchApi'
import { currentAfterEdit, enabledSteps } from './batchLogic'
import { SettingsStrip } from './SettingsStrip'
import { useBatchDialog } from './dialogStore'
import styles from './BatchView.module.css'
import { ExportStep } from './ExportStep'
import { InlineName } from './InlineName'
import { kindLabel } from './labels'
import { NameStep } from './NameStep'
import { OrderStep } from './OrderStep'
import { PickStep } from './PickStep'
import { StepPanel } from './StepPanel'
import { StepRail } from './StepRail'

// The censor editor is big and only one step needs it: it loads on first use.
const CensorStep = lazy(() => import('../censor/CensorStep'))

/** One batch: its name, the step rail on the left, the current step's work on the right. */
export function BatchView({ id }: { id: number }) {
  const t = useT()
  const batch = useBatch(id)
  const setPage = useApp((s) => s.setPage)

  if (batch.isError) {
    const gone = batch.error instanceof ApiError && batch.error.status === 404
    return (
      <section className={styles.notice}>
        <p>{gone ? t('batch.view.gone') : t('batch.view.error', { reason: batch.error.message })}</p>
        <button type="button" className="btn" onClick={() => setPage('batch')}>
          {t('batch.view.backToList')}
        </button>
      </section>
    )
  }
  if (!batch.data) return <section className={styles.notice}>{t('grid.loading')}</section>
  if (batch.data.orphaned) return <Orphaned batch={batch.data} />
  return <Loaded batch={batch.data} />
}

/** V3.5 deleted this dataset batch's project: nothing is left to work on, only the batch to delete. */
function Orphaned({ batch }: { batch: Batch }) {
  const t = useT()
  const setPage = useApp((s) => s.setPage)
  return (
    <section className={styles.notice} data-testid="batch-orphaned-view">
      <p>{t('dataset.orphanedView', { name: batch.name })}</p>
      <button type="button" className="btn" onClick={() => setPage('batch')}>
        {t('batch.view.backToList')}
      </button>
      <button type="button" className="btn btn-danger" onClick={() => useBatchDialog.getState().show({ type: 'delete', batch: { ...batch, orphaned: true } })}>
        {t('batch.delete.button')}
      </button>
    </section>
  )
}

function Loaded({ batch }: { batch: Batch }) {
  const t = useT()
  const setPage = useApp((s) => s.setPage)
  const [renaming, setRenaming] = useState(false)
  const current = currentAfterEdit(batch.steps, batch.current_step)
  const on = enabledSteps(batch.steps)
  const at = on.findIndex((s) => s.id === current)
  const next = at >= 0 ? on[at + 1] : undefined

  const goTo = (step: string) => {
    if (step !== batch.current_step) void patchBatch(batch.id, { current_step: step })
  }

  return (
    <div className={styles.view} data-testid="batch-view" data-batch-id={batch.id} data-strip={batch.kind === 'dataset' || undefined}>
      <header className={styles.head}>
        <button type="button" className="btn btn-ghost" onClick={() => setPage('batch')} data-testid="batch-back">
          <Icon name="left" size={14} />
          {t('batch.view.backToList')}
        </button>
        <span className={styles.rule} aria-hidden />
        {renaming ? (
          <InlineName
            large
            value={batch.name}
            label={t('batch.rename')}
            onCancel={() => setRenaming(false)}
            onDone={(name) => {
              setRenaming(false)
              if (name !== batch.name) void patchBatch(batch.id, { name })
            }}
          />
        ) : (
          <button type="button" className={styles.name} onClick={() => setRenaming(true)} title={t('batch.rename')} data-testid="batch-name">
            {batch.name}
          </button>
        )}
        <span className={styles.kind}>
          {kindLabel(batch.kind, t)}
        </span>
        <span className={`${styles.count} mono`} data-testid="batch-count">
          {t('rail.images', { n: batch.item_count })}
        </span>
      </header>
      {batch.kind === 'dataset' && <SettingsStrip batch={batch} />}
      <div className={styles.body}>
        <StepRail batch={batch} current={current} onGo={goTo} />
        <main className={styles.main}>
          {current === 'pick' ? (
            <PickStep batch={batch} next={next?.id ?? null} onNext={goTo} />
          ) : current === 'censor' ? (
            <Suspense fallback={<section className={styles.notice}>{t('censor.opening')}</section>}>
              <CensorStep batch={batch} next={next?.id ?? null} onNext={goTo} />
            </Suspense>
          ) : current === 'order' ? (
            <OrderStep batch={batch} next={next?.id ?? null} onNext={goTo} />
          ) : current === 'name' ? (
            <NameStep batch={batch} next={next?.id ?? null} onNext={goTo} />
          ) : current === 'export' && batch.kind === 'pixiv' ? (
            <ExportStep batch={batch} onGo={goTo} />
          ) : (
            <StepPanel batch={batch} step={current} next={next?.id ?? null} onNext={goTo} />
          )}
        </main>
      </div>
    </div>
  )
}
