import { useEffect, useLayoutEffect, useState } from 'react'
import type { Batch, BatchItem } from '../../api/types'
import { useT, type MessageKey } from '../../i18n'
import { Icon } from '../../ui/Icon'
import { stepLabel } from '../batch/labels'
import { CanvasView, isDrawing } from './CanvasView'
import { ChangesConfirm } from './ChangesConfirm'
import { requestShowChanges } from './changes'
import styles from './CensorStep.module.css'
import { detectCurrent } from './detectRun'
import { DownloadConfirm } from './DownloadConfirm'
import { Filmstrip } from './Filmstrip'
import type { KeyAction } from './keys'
import type { Op } from './ops'
import { useCensorPanel } from './panel'
import { RemoveBgDialog } from './RemoveBgDialog'
import { reviewActions } from './reviewActions'
import type { ReviewActions } from './ReviewPanel'
import { saveAll } from './saving'
import { changeOps, itemStatus, redoEdit, rememberImage, startImage, syncItems, undoEdit, useEdit, type ImageEdit, type ItemStatus } from './session'
import { useCensorSettings } from './settings'
import { ShortcutList } from './ShortcutList'
import { ToolPanel } from './ToolPanel'
import { useCensorKeys } from './useCensorKeys'
import { useCanvasView } from './view'

// The Pixiv batch's censor step: the batch's images down the left, the picture
// in the middle, the tools on the right (brush, adjust, AI detect, review).
// Every edit is an op list per image; an image's censored copy is rendered and
// saved when the user leaves it.

const NO_OPS: Op[] = []

const STATUS_TEXT: Record<ItemStatus, MessageKey> = {
  clean: 'censor.status.clean',
  dirty: 'censor.status.dirty',
  saving: 'censor.status.saving',
  saved: 'censor.status.saved',
  error: 'censor.status.error',
}

interface Props {
  batch: Batch
  next: string | null
  onNext: (step: string) => void
}

export default function CensorStep({ batch, next, onNext }: Props) {
  const t = useT()
  const items = batch.items
  const [currentId, setCurrentId] = useState(() => startImage(batch))
  const found = items.findIndex((item) => item.image_id === currentId)
  const index = found >= 0 ? found : items.length > 0 ? 0 : -1
  const item = index >= 0 ? items[index] : undefined
  const edit = useEdit(batch.id, item?.image_id ?? null)

  useLayoutEffect(() => syncItems(batch), [batch])

  // Leaving the step, the batch, the page or the library saves what changed.
  useEffect(() => {
    const id = batch.id
    return () => void saveAll(id)
  }, [batch.id])

  const go = (to: number) => {
    const target = items[to]
    if (!target || to === index || isDrawing()) return
    void saveAll(batch.id, target.image_id)
    setCurrentId(target.image_id)
    rememberImage(batch.id, target.image_id)
  }

  // Work that ended while the editor is open asks for an image (detect all opens review on the first one waiting).
  const jump = useCensorPanel((s) => s.jump)
  useEffect(() => {
    if (!jump || jump.batchId !== batch.id) return
    useCensorPanel.setState({ jump: null })
    const to = items.findIndex((i) => i.image_id === jump.imageId)
    if (to >= 0) go(to)
  })

  const [dialog, setDialog] = useState<'bg' | null>(null)
  const review = reviewActions(batch, item, index, go)
  useCensorKeys((action: KeyAction) => {
    if (action.type === 'removeBg') return setDialog('bg')
    runKey(action, { batchId: batch.id, item, index, go, review })
  })

  if (!item) return <section className={styles.empty}>{t('censor.empty')}</section>

  return (
    <section className={styles.editor} aria-label={t('censor.editor')} data-testid="censor-editor">
      <EditorBar batch={batch} item={item} index={index} edit={edit} next={next} onNext={onNext} onGo={go} />
      <div className={styles.work}>
        <Filmstrip batchId={batch.id} items={items} current={index} onPick={go} />
        <div className={styles.stage}>
          <CanvasView key={item.image_id} imageId={item.image_id} ops={edit?.ops ?? NO_OPS} onCommit={(ops) => changeOps(batch.id, item, ops)} />
        </div>
        <ToolPanel batch={batch} item={item} edit={edit} review={review} onRemoveBg={() => setDialog('bg')} />
      </div>
      <DownloadConfirm />
      <ChangesConfirm />
      {dialog === 'bg' && <RemoveBgDialog batchId={batch.id} item={item} onClose={() => setDialog(null)} />}
    </section>
  )
}

interface KeyContext {
  batchId: number
  item: BatchItem | undefined
  index: number
  go: (to: number) => void
  review: ReviewActions
}

function runKey(action: KeyAction, { batchId, item, index, go, review }: KeyContext): void {
  const settings = useCensorSettings.getState()
  switch (action.type) {
    case 'tool':
      return settings.setTool(action.tool)
    case 'size':
      return settings.setSize(settings.size + action.delta)
    case 'fit':
      return useCanvasView.getState().fit()
    case 'save':
      return void saveAll(batchId)
    case 'go':
      return go(index + action.delta)
    case 'detect':
    case 'redetect':
      return item ? void detectCurrent(batchId, item) : undefined
    case 'region':
      return review.toggle(action.n)
    case 'allRegions':
      return review.toggleAll()
    case 'approve':
      return review.approve()
    case 'skip':
      return review.skip()
    case 'changes':
      return requestShowChanges(!useCensorPanel.getState().showChanges)
    case 'removeBg':
      return
    case 'undo':
    case 'redo':
      if (item && !isDrawing()) (action.type === 'undo' ? undoEdit : redoEdit)(batchId, item.image_id)
  }
}

interface BarProps {
  batch: Batch
  item: BatchItem
  index: number
  edit: ImageEdit | undefined
  next: string | null
  onNext: (step: string) => void
  onGo: (index: number) => void
}

function EditorBar({ batch, item, index, edit, next, onNext, onGo }: BarProps) {
  const t = useT()
  const n = batch.items.length
  const status = itemStatus(item, edit)
  const text = t(STATUS_TEXT[status], { reason: edit?.error ?? '' })

  return (
    <div className={styles.bar}>
      <button type="button" className="btn btn-ghost btn-icon" onClick={() => onGo(index - 1)} disabled={index <= 0} title={t('censor.prev')} aria-label={t('censor.prev')} data-testid="censor-prev">
        <Icon name="left" size={14} />
      </button>
      <span className={`${styles.pos} mono`} data-testid="censor-position">
        {t('censor.position', { i: index + 1, n })}
      </span>
      <button type="button" className="btn btn-ghost btn-icon" onClick={() => onGo(index + 1)} disabled={index >= n - 1} title={t('censor.next')} aria-label={t('censor.next')} data-testid="censor-next">
        <Icon name="right" size={14} />
      </button>
      <span className={styles.rule} aria-hidden />
      <span className={`${styles.file} mono`} title={item.filename}>
        {item.filename}
      </span>
      <span className={styles.status} data-state={status} title={text} role="status" data-testid="censor-status">
        {text}
      </span>
      {(status === 'dirty' || status === 'error') && (
        <button type="button" className="btn" onClick={() => void saveAll(batch.id)} title={t('censor.saveNowTip')} data-testid="censor-save">
          {t('censor.saveNow')}
        </button>
      )}
      <span className={styles.gap} />
      <ShortcutList />
      {next && (
        <button type="button" className="btn btn-primary" onClick={() => onNext(next)} data-testid="step-next">
          {t('batch.panel.next', { step: stepLabel(next, t) })}
        </button>
      )}
    </div>
  )
}
