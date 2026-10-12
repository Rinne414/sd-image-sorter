import { useMemo } from 'react'
import type { Batch, BatchItem } from '../../api/types'
import { useT, type MessageKey } from '../../i18n'
import { useToasts } from '../../ui/toasts'
import { useJobs } from '../jobs/jobs'
import { isFinished } from '../jobs/progress'
import { isNoAdjust } from './adjust'
import { PRESET_IDS, useAdjustDraft, type PresetId } from './adjustDraft'
import styles from './AdjustPanel.module.css'
import { applyAdjustHere, applyAdjustTo } from './applyAdjust'
import { colorStats, histogramPath, histogramPeak } from './histogram'
import { ADJUST_KEYS, ADJUST_RANGE, type AdjustKey } from './ops'
import { Section, Slider } from './PanelParts'
import { useCensorPanel } from './panel'
import { useCanvasPixels } from './pixels'
import tp from './ToolPanel.module.css'

const LABEL: Record<AdjustKey, MessageKey> = {
  brightness: 'censor.adjust.brightness',
  contrast: 'censor.adjust.contrast',
  saturation: 'censor.adjust.saturation',
  hue: 'censor.adjust.hue',
  blur: 'censor.adjust.blur',
  sharpen: 'censor.adjust.sharpen',
  temperature: 'censor.adjust.temperature',
  vignette: 'censor.adjust.vignette',
}

const NONE: number[] = []

const PRESET_LABEL: Record<PresetId, MessageKey> = {
  reset: 'censor.adjust.preset.reset',
  vivid: 'censor.adjust.preset.vivid',
  warm: 'censor.adjust.preset.warm',
  cool: 'censor.adjust.preset.cool',
  bw: 'censor.adjust.preset.bw',
  hdr: 'censor.adjust.preset.hdr',
}

interface Props {
  batch: Batch
  item: BatchItem
  onRemoveBg: () => void
}

/** The Adjust tab: filters shown live on the picture, applied to this image, the picked ones or all as picture edits. */
export function AdjustPanel({ batch, item, onRemoveBg }: Props) {
  const t = useT()
  const draft = useAdjustDraft()
  const picked = useCensorPanel((s) => (s.picked.batchId === batch.id ? s.picked.ids : NONE))
  const busy = useJobs((j) => j.jobs.some((job) => ['detect', 'refine', 'adjust'].includes(job.kind) && !isFinished(job.progress.status)))
  const empty = isNoAdjust(draft.values)
  const pickedItems = batch.items.filter((i) => picked.includes(i.image_id))

  return (
    <>
      <Section title={t('censor.adjust.presets')}>
        <div className={styles.presets} role="group" aria-label={t('censor.adjust.presets')}>
          {PRESET_IDS.map((id) => (
            <button key={id} type="button" className="btn" onClick={() => draft.preset(id)} data-testid={`censor-preset-${id}`}>
              {t(PRESET_LABEL[id])}
            </button>
          ))}
        </div>
      </Section>
      <div className={styles.apply}>
        <button type="button" className="btn btn-primary" disabled={empty} onClick={() => void applyAdjustHere(batch.id, item, draft.values)} data-testid="censor-adjust-apply">
          {t('censor.adjust.applyHere')}
        </button>
        <div className={tp.pair}>
          <button
            type="button"
            className="btn"
            disabled={empty || busy || pickedItems.length === 0}
            onClick={() => void applyAdjustTo(batch.id, pickedItems, draft.values)}
            title={t('censor.adjust.pickedTip')}
            data-testid="censor-adjust-apply-picked"
          >
            {t('censor.adjust.applyPicked', { n: pickedItems.length })}
          </button>
          <button type="button" className="btn" disabled={empty || busy} onClick={() => void applyAdjustTo(batch.id, batch.items, draft.values)} data-testid="censor-adjust-apply-all">
            {t('censor.adjust.applyAll', { n: batch.items.length })}
          </button>
        </div>
        <p className={tp.note}>{t('censor.adjust.note')}</p>
      </div>
      <Section title={t('censor.adjust.title')}>
        {ADJUST_KEYS.map((key) => {
          const [min, max, step] = ADJUST_RANGE[key]
          return (
            <Slider
              key={key}
              label={t(LABEL[key])}
              value={draft.values[key]}
              min={min}
              max={max}
              step={step}
              unit={key === 'hue' ? '°' : ''}
              onChange={(v) => draft.set(key, v)}
              testId={`censor-adjust-${key}`}
            />
          )
        })}
      </Section>
      <ColourPreview />
      <Section title={t('censor.bg.title')}>
        <button type="button" className="btn" onClick={onRemoveBg} data-testid="censor-bg-open">
          {t('censor.bg.open')}
          <kbd>R</kbd>
        </button>
      </Section>
    </>
  )
}

/** Histogram and the main colours of the picture as shown (a swatch copies its hex code). */
function ColourPreview() {
  const t = useT()
  const result = useCanvasPixels((s) => s.result)
  const version = useCanvasPixels((s) => s.version)
  // `version` says the pixels changed in place (the raster object stays the same).
  const stats = useMemo(() => (result ? colorStats(result) : null), [result, version])
  if (!stats) return null
  const peak = histogramPeak(stats)
  const copy = (hex: string) => {
    void navigator.clipboard?.writeText(hex)
    useToasts.getState().push(t('censor.adjust.copied', { hex }), 'info')
  }
  return (
    <Section title={t('censor.adjust.colours')} testId="censor-histogram">
      <svg className={styles.histogram} viewBox="0 0 256 60" preserveAspectRatio="none" aria-hidden>
        <path className={styles.histB} d={histogramPath(stats.b, peak, 256, 60)} />
        <path className={styles.histG} d={histogramPath(stats.g, peak, 256, 60)} />
        <path className={styles.histR} d={histogramPath(stats.r, peak, 256, 60)} />
      </svg>
      <div className={styles.swatches}>
        {stats.colors.map((c) => (
          <button key={c.hex} type="button" className={styles.swatch} onClick={() => copy(c.hex)} title={t('censor.adjust.copyTip', { hex: c.hex })}>
            <span className={styles.dot} style={{ background: c.hex }} />
            <span className="mono">{c.hex}</span>
          </button>
        ))}
      </div>
    </Section>
  )
}
