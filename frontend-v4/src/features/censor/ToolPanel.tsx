import { useRef, useState, type ReactNode } from 'react'
import type { BatchItem } from '../../api/types'
import { useT, type MessageKey } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { Icon } from '../../ui/Icon'
import { isDrawing } from './CanvasView'
import { BLOCK_MAX, BLOCK_MIN, OPACITY_MAX, OPACITY_MIN, SIZE_MAX, SIZE_MIN, STYLES, TOOLS, type CensorStyle, type Tool } from './ops'
import { saveImage } from './saving'
import { changeOps, redoEdit, undoEdit, type ImageEdit } from './session'
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

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  unit: string
  onChange: (value: number) => void
  testId: string
  extra?: ReactNode
}

function Slider({ label, value, min, max, unit, onChange, testId, extra }: SliderProps) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldHead}>
        <span>{label}</span>
        {extra}
        <span className={`${styles.value} mono`}>
          {value}
          {unit}
        </span>
      </span>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} data-testid={testId} />
    </label>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>{title}</h3>
      {children}
    </section>
  )
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
  batchId: number
  item: BatchItem
  edit: ImageEdit | undefined
}

/** The right-hand panel: tool, its settings, undo/redo, view, and far below them "back to original". */
export function ToolPanel({ batchId, item, edit }: Props) {
  const t = useT()
  const s = useCensorSettings()
  const [confirming, setConfirming] = useState(false)
  const canUndo = (edit?.history.past.length ?? 0) > 0
  const canRedo = (edit?.history.future.length ?? 0) > 0
  const canReset = (edit?.ops.length ?? 0) > 0 || item.has_censored

  const run = (step: typeof undoEdit) => {
    if (!isDrawing()) step(batchId, item.image_id)
  }

  return (
    <aside className={styles.panel} aria-label={t('censor.tools')} data-testid="censor-tools">
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
        <div className={styles.pair}>
          <button type="button" className="btn" onClick={() => run(undoEdit)} disabled={!canUndo} title={t('censor.undoTip')} data-testid="censor-undo">
            <Icon name="undo" size={14} />
            {t('censor.undo')}
          </button>
          <button type="button" className="btn" onClick={() => run(redoEdit)} disabled={!canRedo} title={t('censor.redoTip')} data-testid="censor-redo">
            <Icon name="redo" size={14} />
            {t('censor.redo')}
          </button>
        </div>
      </Section>
      <Section title={t('censor.view')}>
        <ViewControls />
        <p className={styles.note}>{t('censor.panNote')}</p>
      </Section>
      <div className={styles.danger}>
        <button type="button" className="btn btn-ghost" onClick={() => setConfirming(true)} disabled={!canReset} data-testid="censor-reset">
          {t('censor.reset')}
        </button>
      </div>
      {confirming && <ResetDialog batchId={batchId} item={item} ops={edit?.ops ?? []} onClose={() => setConfirming(false)} />}
    </aside>
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
