import { useEffect, useRef, useState } from 'react'
import type { BatchItem } from '../../api/types'
import { useT, type MessageKey } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { foregroundMask, type MaskShapeLike } from './detectApi'
import { applyChange, cardsFor, opsNow, pictureSize, reason, withModels } from './detectRun'
import { appendBase, BACKGROUND_FILLS, newOpId, type BackgroundFill, type BackgroundOp } from './ops'
import { renderOps } from './paint'
import styles from './RemoveBgDialog.module.css'
import { libraryFor, loadOriginal } from './saving'
import tp from './ToolPanel.module.css'

// Remove background: SAM3 finds the subject (its mask comes back as the alpha
// of a transparent picture), the user picks what the background becomes and
// sees the result, then "apply" adds it as a picture edit (one undo step).

const FILL_LABEL: Record<BackgroundFill, MessageKey> = {
  transparent: 'censor.bg.transparent',
  white: 'censor.bg.white',
  black: 'censor.bg.black',
}

const PREVIEW_MAX = 360

type State = { kind: 'idle' } | { kind: 'working' } | { kind: 'ready'; mask: MaskShapeLike } | { kind: 'none' } | { kind: 'failed'; reason: string }

interface Props {
  batchId: number
  item: BatchItem
  onClose: () => void
}

export function RemoveBgDialog({ batchId, item, onClose }: Props) {
  const t = useT()
  const [fill, setFill] = useState<BackgroundFill>('transparent')
  const [threshold, setThreshold] = useState(50)
  const [state, setState] = useState<State>({ kind: 'idle' })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const op = (mask: MaskShapeLike): BackgroundOp => ({ type: 'background', id: newOpId(), fill, mask })

  const find = async () => {
    setState({ kind: 'working' })
    try {
      const mask = await foregroundMask(item.image_id, threshold / 100, libraryFor(batchId), await pictureSize(item.image_id))
      setState(mask ? { kind: 'ready', mask } : { kind: 'none' })
    } catch (error) {
      setState({ kind: 'failed', reason: reason(error) })
    }
  }

  // The preview: this image's edits plus the new background, scaled into the dialog.
  const mask = state.kind === 'ready' ? state.mask : null
  useEffect(() => {
    if (!mask) return
    let live = true
    void loadOriginal(item.image_id).then((original) => {
      const canvas = canvasRef.current
      if (!live || !canvas) return
      const shown = renderOps(original, appendBase(opsNow(batchId, item), { type: 'background', id: 'preview', fill, mask }))
      const k = Math.min(1, PREVIEW_MAX / Math.max(shown.width, shown.height))
      canvas.width = Math.max(1, Math.round(shown.width * k))
      canvas.height = Math.max(1, Math.round(shown.height * k))
      const full = new OffscreenCanvas(shown.width, shown.height)
      full.getContext('2d')?.putImageData(new ImageData(shown.data, shown.width, shown.height), 0, 0)
      canvas.getContext('2d')?.drawImage(full, 0, 0, canvas.width, canvas.height)
    })
    return () => {
      live = false
    }
  }, [mask, fill, batchId, item])

  const apply = () => {
    if (!mask) return
    void applyChange(batchId, item, (ops) => appendBase(ops, op(mask)), false)
    onClose()
  }

  const footer = (
    <>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn" onClick={() => void withModels(cardsFor('sam3'), 'censor.ask.forSam3', () => void find())} disabled={state.kind === 'working'} data-testid="censor-bg-find">
        {state.kind === 'working' ? t('censor.detect.running') : t('censor.bg.find')}
      </button>
      <button type="button" className="btn btn-primary" onClick={apply} disabled={!mask} data-testid="censor-bg-apply">
        {t('censor.bg.apply')}
      </button>
    </>
  )

  return (
    <Dialog title={t('censor.bg.title')} onClose={onClose} footer={footer} testId="censor-bg-dialog" wide>
      <div className={styles.body}>
        <div className={styles.settings}>
          <div className={styles.fills} role="radiogroup" aria-label={t('censor.bg.fill')}>
            <span className={styles.label}>{t('censor.bg.fill')}</span>
            {BACKGROUND_FILLS.map((f) => (
              <button key={f} type="button" className="btn" role="radio" aria-checked={fill === f} aria-pressed={fill === f} onClick={() => setFill(f)} data-testid={`censor-bg-fill-${f}`}>
                {t(FILL_LABEL[f])}
              </button>
            ))}
          </div>
          <label className={styles.threshold}>
            <span>{t('censor.bg.threshold')}</span>
            <input type="range" min={5} max={95} step={5} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} data-testid="censor-bg-threshold" />
            <span className="mono">{threshold}%</span>
          </label>
          <p className={tp.note}>{t('censor.bg.note')}</p>
        </div>
        <div className={styles.preview} data-fill={fill} data-testid="censor-bg-preview">
          {mask ? <canvas ref={canvasRef} /> : <p className={tp.note}>{stateText(state, t)}</p>}
        </div>
      </div>
    </Dialog>
  )
}

function stateText(state: State, t: ReturnType<typeof useT>): string {
  if (state.kind === 'working') return t('censor.bg.working')
  if (state.kind === 'none') return t('censor.bg.none')
  if (state.kind === 'failed') return t('censor.bg.failed', { reason: state.reason })
  return t('censor.bg.idle')
}
