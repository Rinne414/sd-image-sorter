import { useRef, useState } from 'react'
import type { Batch, BatchItem } from '../../api/types'
import { useT, type MessageKey } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { Icon } from '../../ui/Icon'
import { DetectPanel } from './DetectPanel'
import { useCensorPanel, type PanelTab } from './panel'
import { HistoryButtons, Section, Slider } from './PanelParts'
import { ReviewPanel, type ReviewActions } from './ReviewPanel'
import { BLOCK_MAX, BLOCK_MIN, OPACITY_MAX, OPACITY_MIN, SIZE_MAX, SIZE_MIN, STYLES, TOOLS, type CensorStyle, type Tool } from './ops'
import { saveImage } from './saving'
import { changeOps, editOf, setReviewed, type ImageEdit } from './session'
import { useCensorSettings } from './settings'
import styles from './ToolPanel.module.css'
import { useCanvasView, ZOOM_STEP } from './view'

const TOOL_LABEL: Record<Tool, MessageKey> = { brush: 'censor.tool.brush', pen: 'censor.tool.pen', eraser: 'censor.tool.eraser' }
const TOOL_TIP: Record<Tool, MessageKey> = { brush: 'censor.tool.brushTip', pen: 'censor.tool.penTip', eraser: 'censor.tool.eraserTip' }
const STYLE_LABEL: Record<CensorStyle, MessageKey> = {
  mosaic: 'censor.style.mosaic',
  blur: 'censor.style.blur',
  black: 'censor.style.black',
  white: 'censor.style.white',
}

function ToolSettings() {
  const t = useT()
  const s = useCensorSettings()
  if (s.tool === 'eraser') return <p className={styles.note}>{t('censor.eraserNote')}</p>
  if (s.tool === 'pen') {
    return (
      <>
        <label className={styles.colorField}>
          <span>{t('censor.color')}</span>
          <input type="color" value={s.color} onChange={(e) => s.setColor(e.target.value)} data-testid="censor-color" />
          <span className={`${styles.value} mono`}>{s.color}</span>
        </label>
        <Slider label={t('censor.opacity')} value={s.opacity} min={OPACITY_MIN} max={OPACITY_MAX} unit="%" onChange={s.setOpacity} testId="censor-opacity" />
      </>
    )
  }
  return (
    <>
      <div className={styles.grid} role="group" aria-label={t('censor.style')}>
        {STYLES.map((style) => (
          <button key={style} type="button" className="btn" aria-pressed={s.style === style} onClick={() => s.setStyle(style)} data-testid={`censor-style-${style}`}>
            {t(STYLE_LABEL[style])}
          </button>
        ))}
      </div>
      <Slider label={t('censor.block')} value={s.block} min={BLOCK_MIN} max={BLOCK_MAX} unit=" px" onChange={s.setBlock} testId="censor-block" />
      <p className={styles.note}>{t('censor.blockNote')}</p>
    </>
  )
}

function ViewControls() {
  const t = useT()
  const z = useCanvasView((s) => s.z)
  const view = useCanvasView.getState
  return (
    <div className={styles.row}>
      <button type="button" className="btn btn-icon" onClick={() => view().zoomBy(1 / ZOOM_STEP)} title={t('censor.zoomOut')} aria-label={t('censor.zoomOut')} data-testid="censor-zoom-out">
        <Icon name="minus" size={14} />
      </button>
      <output className={`${styles.zoom} mono`} aria-label={t('censor.zoomLevel')} data-testid="censor-zoom">
        {Math.round(z * 100)}%
      </output>
      <button type="button" className="btn btn-icon" onClick={() => view().zoomBy(ZOOM_STEP)} title={t('censor.zoomIn')} aria-label={t('censor.zoomIn')} data-testid="censor-zoom-in">
        <Icon name="plus" size={14} />
      </button>
      <button type="button" className="btn" onClick={() => view().fit()} title={t('censor.fitTip')} data-testid="censor-fit">
        <Icon name="fit" size={14} />
        {t('censor.fit')}
      </button>
    </div>
  )
}

interface Props {
  batch: Batch
  item: BatchItem
  edit: ImageEdit | undefined
  review: ReviewActions
}

const TABS: { id: PanelTab; label: MessageKey }[] = [
  { id: 'brush', label: 'censor.tab.brush' },
  { id: 'detect', label: 'censor.tab.detect' },
  { id: 'review', label: 'censor.tab.review' },
]

/** The right-hand panel: brush / detect / review tabs, and far below them "back to original". */
export function ToolPanel({ batch, item, edit, review }: Props) {
  const t = useT()
  const tab = useCensorPanel((s) => s.tab)
  const setTab = useCensorPanel((s) => s.setTab)
  const [confirming, setConfirming] = useState(false)
  const canReset = (edit?.ops.length ?? 0) > 0 || item.has_censored

  return (
    <aside className={styles.panel} aria-label={t('censor.tools')} data-testid="censor-tools">
      <div className={styles.tabs} role="tablist" aria-label={t('censor.tools')}>
        {TABS.map(({ id, label }) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={styles.tab} onClick={() => setTab(id)} data-testid={`censor-tab-${id}`}>
            {t(label)}
          </button>
        ))}
      </div>
      <div className={styles.body} role="tabpanel">
        {tab === 'brush' && <BrushTab batchId={batch.id} item={item} edit={edit} />}
        {tab === 'detect' && <DetectPanel batch={batch} item={item} />}
        {tab === 'review' && <ReviewPanel batch={batch} item={item} edit={edit} actions={review} />}
      </div>
      <div className={styles.danger}>
        <button type="button" className="btn btn-ghost" onClick={() => setConfirming(true)} disabled={!canReset} data-testid="censor-reset">
          {t('censor.reset')}
        </button>
      </div>
      {confirming && <ResetDialog batchId={batch.id} item={item} ops={edit?.ops ?? []} onClose={() => setConfirming(false)} />}
    </aside>
  )
}

function BrushTab({ batchId, item, edit }: { batchId: number; item: BatchItem; edit: ImageEdit | undefined }) {
  const t = useT()
  const s = useCensorSettings()
  return (
    <>
      <Section title={t('censor.tools')}>
        <div className={styles.tools} role="group" aria-label={t('censor.tools')}>
          {TOOLS.map((tool) => (
            <button key={tool} type="button" className="btn" aria-pressed={s.tool === tool} onClick={() => s.setTool(tool)} title={t(TOOL_TIP[tool])} data-testid={`censor-tool-${tool}`}>
              {t(TOOL_LABEL[tool])}
              <kbd>{tool[0]?.toUpperCase()}</kbd>
            </button>
          ))}
        </div>
        <Slider
          label={t('censor.size')}
          value={s.size}
          min={SIZE_MIN}
          max={SIZE_MAX}
          unit=" px"
          onChange={s.setSize}
          testId="censor-size"
          extra={
            <span className={styles.keys} title={t('censor.sizeKeys')}>
              <kbd>[</kbd>
              <kbd>]</kbd>
            </span>
          }
        />
      </Section>
      <Section title={s.tool === 'brush' ? t('censor.style') : t(TOOL_LABEL[s.tool])}>
        <ToolSettings />
      </Section>
      <Section title={t('censor.history')}>
        <HistoryButtons batchId={batchId} item={item} edit={edit} />
      </Section>
      <Section title={t('censor.view')}>
        <ViewControls />
        <p className={styles.note}>{t('censor.panNote')}</p>
      </Section>
    </>
  )
}

interface ResetProps {
  batchId: number
  item: BatchItem
  ops: ImageEdit['ops']
  onClose: () => void
}

/** "Back to original": every op goes (one undo step) and the saved copy is deleted right away. */
function ResetDialog({ batchId, item, ops, onClose }: ResetProps) {
  const t = useT()
  const cancelRef = useRef<HTMLButtonElement>(null)

  const go = () => {
    onClose()
    if (ops.length > 0) changeOps(batchId, item, [])
    // An approval was for the censoring just removed: the image goes back to waiting
    // for review, so no copy is kept (an approved image always has one).
    if (editOf(batchId, item.image_id)?.reviewed === true) setReviewed(batchId, item, false)
    void saveImage(batchId, item.image_id, true)
  }

  const footer = (
    <>
      <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn btn-danger" onClick={go} data-testid="censor-reset-ok">
        {t('censor.reset.ok')}
      </button>
    </>
  )

  return (
    <Dialog title={t('censor.reset.title', { name: item.filename })} onClose={onClose} footer={footer} testId="censor-reset-dialog" initialFocus={cancelRef}>
      <p className={styles.dialogBody}>{t('censor.reset.body')}</p>
    </Dialog>
  )
}
