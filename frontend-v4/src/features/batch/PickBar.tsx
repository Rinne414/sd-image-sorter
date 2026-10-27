import { useRef } from 'react'
import { useT } from '../../i18n'
import { useApp } from '../../state/store'
import { Menu } from '../../ui/Menu'
import { menuItemsOf } from '../selection/actions'
import { useBulkActions } from '../selection/actionOps'
import { useToasts } from '../../ui/toasts'
import { openFolderDialog, uploadInto, useDatasetImport } from './datasetImport'
import { stepLabel } from './labels'
import styles from './PickStep.module.css'

interface Props {
  batchId: number
  total: number
  folderCount: number
  selected: number
  /** The selected images that are in the Library (folder images have no id). */
  pickedImageIds: number[]
  isDataset: boolean
  next: string | null
  onNext: (step: string) => void
  onRemoveSelected: () => void
  onClearSelection: () => void
  onSelectAll: () => void
}

/** The pick step's bar: how many, what is selected, and where more images come from. */
export function PickBar(p: Props) {
  const t = useT()
  const fileRef = useRef<HTMLInputElement>(null)
  const importing = useDatasetImport((s) => (s.batchId === p.batchId ? s.label : null))

  const addFromLibrary = () => {
    const s = useApp.getState()
    s.setAdding({ batchId: p.batchId })
    s.setPage('library')
  }

  return (
    <div className={styles.bar} data-testid="pick-bar">
      <strong className={styles.count} data-testid="pick-count">
        {p.folderCount > 0 ? t('dataset.countWithFolder', { n: p.total, folder: p.folderCount }) : t('batch.pick.count', { n: p.total })}
      </strong>
      {p.selected > 0 ? (
        <>
          <span className={styles.selectedCount} data-testid="pick-selected">
            {t('dataset.selected', { n: p.selected })}
          </span>
          <AddPicksToBatch batchId={p.batchId} ids={p.pickedImageIds} folderPicked={p.selected - p.pickedImageIds.length} />
          <button type="button" className="btn" onClick={p.onRemoveSelected} data-testid="pick-remove-selected">
            {t('dataset.removeSelected', { n: p.selected })}
          </button>
          <button type="button" className="btn btn-ghost" onClick={p.onClearSelection}>
            {t('dataset.clearSelection')}
          </button>
        </>
      ) : (
        <>
          <span className={styles.hint}>{t('dataset.pickKeys')}</span>
          {p.total > 1 && (
            <button type="button" className="btn btn-ghost" onClick={p.onSelectAll} data-testid="pick-select-all">
              {t('dataset.selectAll')}
            </button>
          )}
        </>
      )}
      <span className={styles.gap} />
      {importing && (
        <span className={styles.busy} aria-live="polite" data-testid="dataset-importing">
          {importing}
        </span>
      )}
      <button type="button" className={p.total ? 'btn' : 'btn btn-primary'} onClick={addFromLibrary} data-testid="add-from-library">
        {t('batch.pick.addMore')}
      </button>
      {p.isDataset && (
        <>
          <button type="button" className="btn" onClick={() => openFolderDialog(p.batchId)} disabled={importing !== null} data-testid="add-from-folder">
            {t('dataset.addFolder')}
          </button>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={importing !== null} data-testid="add-files">
            {t('dataset.addFiles')}
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            accept="image/*,.zip,.rar"
            data-testid="add-files-input"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ''
              if (files.length) void uploadInto(p.batchId, files)
            }}
          />
        </>
      )}
      {p.next && p.total > 0 && (
        <button type="button" className="btn btn-primary" onClick={() => p.next && p.onNext(p.next)} data-testid="step-next">
          {t('batch.panel.next', { step: stepLabel(p.next, t) })}
        </button>
      )}
    </div>
  )
}

/**
 * The selected images into another batch, the way the Library's selection bar
 * does it (a new batch, a template, a recent batch). A batch is V Opus's group of
 * images, so this is where classic's "add to a collection" lives.
 */
function AddPicksToBatch({ batchId, ids, folderPicked }: { batchId: number; ids: number[]; folderPicked: number }) {
  const t = useT()
  const actions = useBulkActions(ids)
  const batch = actions.find((a) => a.id === 'batch')
  if (ids.length === 0 || !batch) {
    return (
      <button type="button" className="btn" disabled title={t('collections.folderOnly')} data-testid="pick-add-to-batch">
        {t('batch.menu.label')}
      </button>
    )
  }
  const children = (batch.children ?? [])
    .filter((c) => c.id !== `batch-add-${batchId}`)
    .map((c) => ({
      ...c,
      run: () => {
        c.run?.()
        if (folderPicked > 0) useToasts.getState().push(t('collections.folderLeftOut', { n: folderPicked }), 'info')
      },
    }))
  return <Menu label={t('batch.menu.label')} items={menuItemsOf(t, children)} testId="pick-add-to-batch" />
}
