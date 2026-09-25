import type { ReactNode } from 'react'
import type { BatchItem } from '../../api/types'
import { useT } from '../../i18n'
import { Icon } from '../../ui/Icon'
import { isDrawing } from './CanvasView'
import { redoEdit, undoEdit, type ImageEdit } from './session'
import styles from './ToolPanel.module.css'

// Pieces the tool panel's tabs share.

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  unit: string
  onChange: (value: number) => void
  testId: string
  extra?: ReactNode
  step?: number
}

export function Slider({ label, value, min, max, unit, onChange, testId, extra, step }: SliderProps) {
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
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} data-testid={testId} />
    </label>
  )
}

export function Section({ title, children, testId }: { title: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className={styles.section} data-testid={testId}>
      <h3 className={styles.heading}>{title}</h3>
      {children}
    </section>
  )
}

/** Undo and redo: every tab has them (a detection is one undo step too). */
export function HistoryButtons({ batchId, item, edit }: { batchId: number; item: BatchItem; edit: ImageEdit | undefined }) {
  const t = useT()
  const canUndo = (edit?.history.past.length ?? 0) > 0
  const canRedo = (edit?.history.future.length ?? 0) > 0
  const run = (step: typeof undoEdit) => {
    if (!isDrawing()) step(batchId, item.image_id)
  }
  return (
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
  )
}
