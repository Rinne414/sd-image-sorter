import type { ReactNode } from 'react'
import { useT, type MessageKey } from '../../../i18n'
import type { MaskExport, ProjectSettings } from '../datasetSettings'
import pix from '../ExportStep.module.css'
import styles from './DatasetExport.module.css'
import { maskChoices, optionBlock, type OptionBlock } from './plan'
import { BLOCK_KEY } from './texts'
import { NumberField } from './TrainingFields'
import type { ExportOptions } from './useExportOptions'

type Crop = NonNullable<ProjectSettings['subject_crop']>
type Bucket = NonNullable<ProjectSettings['bucket_resize']>
type Watermark = NonNullable<ProjectSettings['watermark_removal']>

const CROP: Crop = { enabled: false, alpha_threshold: 1, padding_percent: 5, background_mode: 'keep_background', solid_color: '#000000' }
const BUCKET: Bucket = { enabled: false, subject_aware: false, alpha_threshold: 128 }
/** A first rectangle where signatures usually are: the bottom-right corner. */
const WATERMARK: Watermark = { enabled: false, method: 'telea', radius: 3, padding_percent: 1, regions: [{ x: 7500, y: 9000, width: 2500, height: 1000 }] }
const BACKGROUNDS: readonly Crop['background_mode'][] = ['keep_background', 'transparent_rgba', 'solid_color']

interface OptionProps {
  label: string
  checked: boolean
  block: OptionBlock | null
  /** Why it is off, when the rule has its own words. */
  why?: MessageKey
  onChange: (on: boolean) => void
  testId: string
  children?: ReactNode
}

function Option({ label, checked, block, why, onChange, testId, children }: OptionProps) {
  const t = useT()
  const reason = why ?? (block ? BLOCK_KEY[block] : null)
  return (
    <div className={styles.option} data-blocked={block ? '' : undefined} data-testid={testId}>
      <label className={pix.check}>
        <input type="checkbox" checked={checked} disabled={block !== null && !checked} onChange={(e) => onChange(e.target.checked)} data-testid={`${testId}-on`} />
        <span>{label}</span>
      </label>
      {block && reason && <p className={styles.why} data-testid={`${testId}-why`}>{t(reason)}</p>}
      {checked && children && <div className={styles.sub}>{children}</div>}
    </div>
  )
}

/** Masks, subject crop, buckets and watermark removal; then the two caption options. */
export function ProcessingFields({ o, s, folderImages }: { o: ExportOptions; s: ProjectSettings; folderImages: number }) {
  const t = useT()
  const crop = s.subject_crop ?? CROP
  const bucket = s.bucket_resize ?? BUCKET
  const wm = s.watermark_removal ?? { ...WATERMARK, regions: [] }
  const set = (change: Partial<ProjectSettings>) => o.update((cur) => ({ ...cur, ...change }))
  return (
    <>
      <section className={pix.group}>
        <h3 className={pix.groupTitle}>{t('dataset.export.processing')}</h3>
        <MaskField o={o} s={s} />
        <Option label={t('dataset.export.crop')} checked={crop.enabled} block={optionBlock('crop', s, folderImages)} onChange={(on) => set({ subject_crop: { ...CROP, ...s.subject_crop, enabled: on } })} testId="ds-crop">
          <CropFields crop={crop} onChange={(c) => set({ subject_crop: c })} />
        </Option>
        <Option label={t('dataset.export.bucket')} checked={bucket.enabled} block={optionBlock('bucket', s, folderImages)} onChange={(on) => set({ bucket_resize: { ...bucket, enabled: on } })} testId="ds-bucket">
          <label className={pix.check}>
            <input type="checkbox" checked={bucket.subject_aware} disabled={folderImages > 0 && !bucket.subject_aware} onChange={(e) => set({ bucket_resize: { ...bucket, subject_aware: e.target.checked } })} />
            <span>{t('dataset.export.bucketSubject')}</span>
          </label>
          <NumberField
            label={t('dataset.export.resolution')}
            value={s.trainer.resolution}
            bounds={{ minimum: 256, maximum: 4096 }}
            step={64}
            onChange={(v) => set({ trainer: { ...s.trainer, resolution: v } })}
            testId="ds-bucket-resolution"
          />
          <p className={styles.note}>{t('dataset.export.bucketHint')}</p>
        </Option>
        <Option
          label={t('dataset.export.watermark')}
          checked={wm.enabled}
          block={optionBlock('watermark', s, folderImages)}
          onChange={(on) => set({ watermark_removal: on && !(wm.regions ?? []).length ? { ...WATERMARK, enabled: true } : { ...wm, enabled: on } })}
          testId="ds-watermark"
        >
          <WatermarkFields wm={wm} onChange={(w) => set({ watermark_removal: w })} />
        </Option>
      </section>
      <section className={pix.group}>
        <h3 className={pix.groupTitle}>{t('dataset.export.captions')}</h3>
        <Option
          label={t('dataset.export.json')}
          checked={o.v4.json_sidecar}
          block={optionBlock('json', s, folderImages)}
          why="dataset.export.block.jsonPackage"
          onChange={(on) => o.setV4({ json_sidecar: on })}
          testId="ds-json"
        >
          <p className={styles.note}>{t('dataset.export.jsonNote')}</p>
        </Option>
        <Option
          label={t('dataset.export.nl')}
          checked={o.v4.nl_sidecar}
          block={optionBlock('nl', s, folderImages) ?? (o.v4.json_sidecar ? 'json' : null)}
          why={optionBlock('nl', s, folderImages) ? 'dataset.export.block.nlPackage' : undefined}
          onChange={(on) => o.setV4({ nl_sidecar: on })}
          testId="ds-nl"
        />
        <Option label={t('dataset.export.dedupe')} checked={o.v4.dedupe_implications} block={null} onChange={(on) => o.setV4({ dedupe_implications: on })} testId="ds-dedupe" />
      </section>
    </>
  )
}

function MaskField({ o, s }: { o: ExportOptions; s: ProjectSettings }) {
  const t = useT()
  const block = optionBlock('masks', s, 0)
  return (
    <div className={styles.option} data-testid="ds-masks">
      <label className={pix.inline}>
        <span>{t('dataset.export.masks')}</span>
        <select
          className={pix.select}
          value={s.trainer.mask_export}
          disabled={block !== null && s.trainer.mask_export === 'none'}
          onChange={(e) => o.update((cur) => ({ ...cur, trainer: { ...cur.trainer, mask_export: e.target.value as MaskExport } }))}
          data-testid="ds-masks-select"
        >
          {maskChoices(s).map((m) => (
            <option key={m} value={m}>
              {t(`dataset.export.mask.${m}` as MessageKey)}
            </option>
          ))}
        </select>
      </label>
      {block ? <p className={styles.why}>{t(BLOCK_KEY[block])}</p> : s.trainer.mask_export !== 'none' && <p className={styles.why}>{t('dataset.export.masksHint')}</p>}
    </div>
  )
}

function CropFields({ crop, onChange }: { crop: Crop; onChange: (c: Crop) => void }) {
  const t = useT()
  return (
    <>
      <NumberField label={t('dataset.export.cropPadding')} value={crop.padding_percent} bounds={{ minimum: 0, maximum: 100 }} onChange={(v) => onChange({ ...crop, padding_percent: v })} testId="ds-crop-padding" />
      <label className={pix.inline}>
        <span>{t('dataset.export.cropBackground')}</span>
        <select className={pix.select} value={crop.background_mode} onChange={(e) => onChange({ ...crop, background_mode: e.target.value as Crop['background_mode'] })}>
          {BACKGROUNDS.map((b) => (
            <option key={b} value={b}>
              {t(`dataset.export.cropBg.${b}` as MessageKey)}
            </option>
          ))}
        </select>
      </label>
      {crop.background_mode === 'solid_color' && (
        <input type="color" className={pix.color} value={crop.solid_color.toLowerCase()} aria-label={t('dataset.export.cropBackground')} onChange={(e) => onChange({ ...crop, solid_color: e.target.value.toUpperCase() })} />
      )}
      <p className={styles.note}>{t('dataset.export.cropHint')}</p>
    </>
  )
}

const pct = (basis: number) => Math.round(basis / 100)

function WatermarkFields({ wm, onChange }: { wm: Watermark; onChange: (w: Watermark) => void }) {
  const t = useT()
  const region = (wm.regions ?? [])[0] ?? { x: 7500, y: 9000, width: 2500, height: 1000 }
  const setRegion = (change: Partial<typeof region>) => {
    const next = { ...region, ...change }
    // The rectangle stays inside the picture: width and height give way to the corner.
    const fitted = { ...next, width: Math.max(100, Math.min(next.width, 10000 - next.x)), height: Math.max(100, Math.min(next.height, 10000 - next.y)) }
    onChange({ ...wm, regions: [fitted, ...(wm.regions ?? []).slice(1)] })
  }
  const edge = (key: 'x' | 'y' | 'width' | 'height', label: MessageKey, min: number) => (
    <NumberField label={t(label)} value={pct(region[key])} bounds={{ minimum: min, maximum: min === 0 ? 99 : 100 }} onChange={(v) => setRegion({ [key]: v * 100 })} testId={`ds-wm-${key}`} />
  )
  return (
    <>
      {edge('x', 'dataset.export.wmLeft', 0)}
      {edge('y', 'dataset.export.wmTop', 0)}
      {edge('width', 'dataset.export.wmWidth', 1)}
      {edge('height', 'dataset.export.wmHeight', 1)}
      <label className={pix.inline}>
        <span>{t('dataset.export.wmMethod')}</span>
        <select className={pix.select} value={wm.method} onChange={(e) => onChange({ ...wm, method: e.target.value as Watermark['method'] })}>
          <option value="telea">Telea</option>
          <option value="ns">Navier-Stokes</option>
        </select>
      </label>
      <NumberField label={t('dataset.export.wmRadius')} value={wm.radius} bounds={{ minimum: 1, maximum: 20 }} onChange={(v) => onChange({ ...wm, radius: v })} testId="ds-wm-radius" />
      <p className={styles.note}>{t('dataset.export.wmHint')}</p>
    </>
  )
}
