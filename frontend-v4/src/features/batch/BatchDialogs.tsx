import { useMemo, useRef, useState } from 'react'
import type { Batch, BatchStep } from '../../api/types'
import { useLang, useT } from '../../i18n'
import { useApp } from '../../state/store'
import { Dialog } from '../../ui/Dialog'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'
import { createBatch, deleteBatch, saveTemplate, useBatches, useBatchTemplates } from './batchApi'
import { useBatchDialog, type BatchDialog } from './dialogStore'
import { defaultBatchName, enabledSteps, templateSettings } from './batchLogic'
import styles from './BatchDialogs.module.css'
import { kindLabel, stepLabel } from './labels'

const NAME_MAX = 200

/** Mounts whichever batch dialog is open. */
export function BatchDialogs() {
  const dialog = useBatchDialog((s) => s.dialog)
  const close = useBatchDialog((s) => s.close)
  if (!dialog) return null
  if (dialog.type === 'create') return <CreateDialog dialog={dialog} onClose={close} />
  if (dialog.type === 'delete') return <DeleteDialog batch={dialog.batch} onClose={close} />
  return <TemplateDialog batch={dialog.batch} onClose={close} />
}

function StepsLine({ steps }: { steps: BatchStep[] }) {
  const t = useT()
  const names = enabledSteps(steps).map((s) => stepLabel(s.id, t))
  return <p className={styles.steps}>{t('batch.new.steps', { steps: names.join(' → ') })}</p>
}

function afterCreate(batch: Batch, origin: 'selection' | 'adding' | 'page'): void {
  const s = useApp.getState()
  if (origin === 'selection') {
    useToasts.getState().push(tr('batch.created', { name: batch.name, n: batch.item_count }), 'info', {
      label: tr('batch.open'),
      run: () => useApp.getState().openBatch(batch.id),
    })
    return
  }
  if (origin === 'adding') {
    s.clearSelection()
    s.setAdding(null)
  }
  s.openBatch(batch.id)
}

function CreateDialog({ dialog, onClose }: { dialog: Extract<BatchDialog, { type: 'create' }>; onClose: () => void }) {
  const t = useT()
  const lang = useLang((s) => s.lang)
  const all = useBatches(true)
  const templates = useBatchTemplates()
  const { kind, template, imageIds, origin } = dialog
  const base = template?.name ?? kindLabel(kind, t)
  const suggested = useMemo(
    () => defaultBatchName(base, new Date(), lang, (all.data ?? []).map((b) => b.name)),
    [base, lang, all.data],
  )
  const [name, setName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const value = name ?? suggested
  const steps = template?.steps ?? templates.data?.builtin_steps[kind] ?? []
  const n = imageIds.length

  const go = async () => {
    if (!value.trim() || busy) return
    setBusy(true)
    const batch = await createBatch({ kind, name: value, templateId: template?.id ?? null, imageIds })
    setBusy(false)
    if (!batch) return
    onClose()
    afterCreate(batch, origin)
  }

  const title = template ? t('batch.new.fromTemplate', { name: template.name }) : t(`batch.new.title.${kind}`)
  const footer = (
    <>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void go()} disabled={!value.trim() || busy} data-testid="batch-create-ok">
        {n > 0 ? t('batch.new.okWith', { n }) : t('batch.new.ok')}
      </button>
    </>
  )

  return (
    <Dialog title={title} onClose={onClose} footer={footer} testId="batch-create-dialog" initialFocus={inputRef}>
      <label className={styles.field}>
        <span>{t('batch.new.name')}</span>
        <input
          ref={inputRef}
          value={value}
          maxLength={NAME_MAX}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void go()
            }
          }}
          data-testid="batch-name-input"
        />
      </label>
      <p className={styles.note}>{n > 0 ? t('batch.new.withPicks', { n }) : t('batch.new.empty')}</p>
      {steps.length > 0 && <StepsLine steps={steps} />}
    </Dialog>
  )
}

function DeleteDialog({ batch, onClose }: { batch: { id: number; name: string; item_count: number }; onClose: () => void }) {
  const t = useT()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)

  const go = async () => {
    setBusy(true)
    const ok = await deleteBatch(batch)
    setBusy(false)
    if (ok) onClose()
  }

  const footer = (
    <>
      <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn btn-danger" onClick={() => void go()} disabled={busy} data-testid="batch-delete-ok">
        {t('batch.delete.ok')}
      </button>
    </>
  )

  return (
    <Dialog title={t('batch.delete.title', { name: batch.name })} onClose={onClose} footer={footer} testId="batch-delete-dialog" initialFocus={cancelRef}>
      <p className={styles.body}>{t('batch.delete.body', { n: batch.item_count })}</p>
    </Dialog>
  )
}

function TemplateDialog({ batch, onClose }: { batch: Batch; onClose: () => void }) {
  const t = useT()
  const [name, setName] = useState(batch.name)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const go = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    const saved = await saveTemplate(batch.kind, name, batch.steps, templateSettings(batch.settings))
    setBusy(false)
    if (saved) onClose()
  }

  const footer = (
    <>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void go()} disabled={!name.trim() || busy} data-testid="template-save-ok">
        {t('batch.template.ok')}
      </button>
    </>
  )

  return (
    <Dialog title={t('batch.template.title')} onClose={onClose} footer={footer} testId="template-dialog" initialFocus={inputRef}>
      <label className={styles.field}>
        <span>{t('batch.template.name')}</span>
        <input
          ref={inputRef}
          value={name}
          maxLength={NAME_MAX}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void go()
            }
          }}
          data-testid="template-name-input"
        />
      </label>
      <p className={styles.note}>{t('batch.template.note', { kind: kindLabel(batch.kind, t) })}</p>
      <StepsLine steps={batch.steps} />
    </Dialog>
  )
}
