import { useT } from '../../../i18n'
import type { ProjectSettings } from '../datasetSettings'
import pix from '../ExportStep.module.css'
import { numbersFixed } from '../trainerRules'
import styles from './DatasetExport.module.css'
import { formatOf, stepsEstimate } from './plan'
import type { ExportOptions } from './useExportOptions'

/** V3.5's bounds for "no trainer package" (and the fallback while the trainer list loads). */
const GENERIC = {
  repeats: { minimum: 1, maximum: 1000 },
  batch_size: { minimum: 1, maximum: 64 },
  resolution: { minimum: 256, maximum: 4096 },
  keep_tokens: { minimum: 0, maximum: 50 },
}
const EPOCHS = { minimum: 1, maximum: 1000 }

interface NumberProps {
  label: string
  value: number
  bounds: { minimum: number; maximum: number }
  step?: number
  onChange: (value: number) => void
  testId: string
}

export function NumberField({ label, value, bounds, step = 1, onChange, testId }: NumberProps) {
  return (
    <label className={styles.number}>
      <span>{label}</span>
      <input
        type="number"
        min={bounds.minimum}
        max={bounds.maximum}
        step={step}
        value={value}
        onChange={(e) => {
          const n = Math.round(Number(e.target.value))
          if (e.target.value !== '' && Number.isFinite(n)) onChange(Math.max(bounds.minimum, Math.min(bounds.maximum, n)))
        }}
        data-testid={testId}
      />
    </label>
  )
}

/** Repeats, batch and epochs with the steps they make; resolution and keep_tokens where the trainer takes them. */
export function TrainingFields({ o, s, images }: { o: ExportOptions; s: ProjectSettings; images: number }) {
  const t = useT()
  const format = formatOf(s)
  if (format === 'beside') return null
  const bounds = o.contracts?.bounds[s.trainer.config] ?? GENERIC
  const setTrainer = (change: Partial<ProjectSettings['trainer']>) => o.update((cur) => ({ ...cur, trainer: { ...cur.trainer, ...change } }))
  const epochs = s.planning.epochs
  const steps = stepsEstimate(images, s.trainer.repeats, s.trainer.batch, epochs)
  const trigger = s.caption_render.trigger.trim()
  return (
    <section className={pix.group}>
      <h3 className={pix.groupTitle}>{t('dataset.export.training')}</h3>
      <div className={styles.row}>
        <NumberField label={t('dataset.export.repeats')} value={s.trainer.repeats} bounds={bounds.repeats} onChange={(v) => setTrainer({ repeats: v })} testId="ds-repeats" />
        <NumberField label={t('dataset.export.batch')} value={s.trainer.batch} bounds={bounds.batch_size} onChange={(v) => setTrainer({ batch: v })} testId="ds-batch" />
        <NumberField
          label={t('dataset.export.epochs')}
          value={epochs}
          bounds={EPOCHS}
          onChange={(v) => o.update((cur) => ({ ...cur, planning: { ...cur.planning, epochs: v } }))}
          testId="ds-epochs"
        />
      </div>
      <p className={styles.estimate} title={t('dataset.export.stepsRule')} data-testid="ds-steps">
        {t('dataset.export.steps', { images, repeats: s.trainer.repeats, batch: s.trainer.batch, epochs })} <b>{steps.toLocaleString()}</b>
      </p>
      {format === 'kohya' && (
        <>
          <div className={styles.row}>
            <NumberField
              label={t('dataset.export.resolution')}
              value={s.trainer.resolution}
              bounds={bounds.resolution}
              step={64}
              onChange={(v) => setTrainer({ resolution: v })}
              testId="ds-resolution"
            />
            <NumberField label={t('dataset.export.keepTokens')} value={s.trainer.keep_tokens} bounds={bounds.keep_tokens} onChange={(v) => setTrainer({ keep_tokens: v })} testId="ds-keep-tokens" />
            {trigger && s.trainer.keep_tokens === 0 && (
              <button type="button" className="btn btn-ghost" onClick={() => setTrainer({ keep_tokens: 1 })} data-testid="ds-keep-trigger">
                {t('dataset.export.keepTrigger')}
              </button>
            )}
          </div>
          <p className={styles.note}>{t('dataset.export.keepTokensHint')}</p>
        </>
      )}
      {format === 'anima' && <p className={styles.note}>{t('dataset.export.animaFixed')}</p>}
      {format === 'folder' && numbersFixed(s) && <p className={styles.note}>{t('dataset.export.folderNumbers')}</p>}
    </section>
  )
}
