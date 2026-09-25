import { useMemo, useState } from 'react'
import { useT, type MessageKey } from '../../i18n'
import { FolderChooser } from '../../ui/FolderChooser'
import {
  METADATA_OPTIONS,
  OUTPUT_FORMATS,
  WATERMARK_POSITIONS,
  type ExportSettings,
  type MetadataOption,
  type OutputFormat,
  type WatermarkPosition,
  type WatermarkSettings,
} from './exportSettings'
import styles from './ExportStep.module.css'

const RECENT_KEY = 'sd-v4-recent-export-folders'
const RECENT_MAX = 8

function recentFolders(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string' && p.length > 0) : []
  } catch {
    return []
  }
}

function rememberFolder(path: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([path, ...recentFolders().filter((p) => p !== path)].slice(0, RECENT_MAX)))
  } catch {
    // storage blocked: the list just won't be remembered
  }
}

const META_LABEL: Record<MetadataOption, MessageKey> = {
  strip: 'batch.export.meta.strip',
  minimal: 'batch.export.meta.minimal',
  keep: 'batch.export.meta.keep',
}
const META_NOTE: Record<MetadataOption, MessageKey> = {
  strip: 'batch.export.meta.stripNote',
  minimal: 'batch.export.meta.minimalNote',
  keep: 'batch.export.meta.keepNote',
}
const FORMAT_LABEL: Record<OutputFormat, MessageKey> = {
  original: 'batch.export.format.original',
  png: 'batch.export.format.png',
  jpg: 'batch.export.format.jpg',
  webp: 'batch.export.format.webp',
}
const POSITION_LABEL: Record<WatermarkPosition, MessageKey> = {
  top_left: 'batch.export.wm.pos.topLeft',
  top_right: 'batch.export.wm.pos.topRight',
  center: 'batch.export.wm.pos.center',
  bottom_left: 'batch.export.wm.pos.bottomLeft',
  bottom_right: 'batch.export.wm.pos.bottomRight',
}

interface Props {
  settings: ExportSettings
  update: (change: Partial<ExportSettings>) => void
  disabled: boolean
}

/** Where the files go and how they are written. Every choice is saved with the batch. */
export function ExportForm({ settings, update, disabled }: Props) {
  const t = useT()
  const [choosing, setChoosing] = useState(false)
  const recent = useMemo(recentFolders, [choosing])

  return (
    <fieldset className={styles.form} disabled={disabled} data-testid="export-form">
      <section className={styles.group}>
        <h3 className={styles.groupTitle}>{t('batch.export.folder')}</h3>
        <div className={styles.folderRow}>
          <span className={`${styles.folder} mono`} data-empty={!settings.output_folder || undefined} data-testid="export-folder" title={settings.output_folder}>
            {settings.output_folder || t('batch.export.folderNone')}
          </span>
          <button type="button" className="btn" onClick={() => setChoosing(true)} data-testid="export-choose-folder">
            {t('batch.export.chooseFolder')}
          </button>
        </div>
      </section>

      <section className={styles.group} role="radiogroup" aria-label={t('batch.export.meta')}>
        <h3 className={styles.groupTitle}>{t('batch.export.meta')}</h3>
        {METADATA_OPTIONS.map((option) => (
          <label key={option} className={styles.choice} data-option={option}>
            <input type="radio" name="export-meta" checked={settings.metadata_option === option} onChange={() => update({ metadata_option: option })} data-testid={`export-meta-${option}`} />
            <span className={styles.choiceText}>
              <span>{t(META_LABEL[option])}</span>
              <span className={styles.choiceNote} data-tone={option === 'keep' ? 'danger' : undefined}>
                {t(META_NOTE[option])}
              </span>
            </span>
          </label>
        ))}
      </section>

      <section className={styles.group}>
        <h3 className={styles.groupTitle}>{t('batch.export.file')}</h3>
        <label className={styles.inline}>
          <span>{t('batch.export.format')}</span>
          <select className={styles.select} value={settings.output_format} onChange={(e) => update({ output_format: e.target.value as OutputFormat })} data-testid="export-format">
            {OUTPUT_FORMATS.map((format) => (
              <option key={format} value={format}>
                {t(FORMAT_LABEL[format])}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={settings.overwrite} onChange={(e) => update({ overwrite: e.target.checked })} data-testid="export-overwrite" />
          <span>{t('batch.export.overwrite')}</span>
        </label>
      </section>

      <section className={styles.group}>
        <h3 className={styles.groupTitle}>{t('batch.export.caption')}</h3>
        <textarea
          className={styles.caption}
          rows={3}
          value={settings.caption_text}
          placeholder={t('batch.export.captionHint')}
          onChange={(e) => update({ caption_text: e.target.value })}
          data-testid="export-caption"
        />
      </section>

      <WatermarkFields watermark={settings.watermark} onChange={(watermark) => update({ watermark })} />

      {choosing && (
        <FolderChooser
          title={t('batch.export.chooseTitle')}
          confirmLabel={t('batch.export.chooseOk')}
          start={settings.output_folder || recent[0] || null}
          shortcuts={[{ heading: t('batch.export.recentFolders'), paths: recent, testId: 'export-recent' }]}
          onChoose={async (target) => {
            update({ output_folder: target })
            rememberFolder(target)
            return true
          }}
          onClose={() => setChoosing(false)}
          testId="export-folder-picker"
        />
      )}
    </fieldset>
  )
}

function WatermarkFields({ watermark, onChange }: { watermark: WatermarkSettings; onChange: (next: WatermarkSettings) => void }) {
  const t = useT()
  const set = (change: Partial<WatermarkSettings>) => onChange({ ...watermark, ...change })
  const number = (key: 'opacity' | 'size_percent' | 'margin_percent', min: number, max: number, label: MessageKey, unit: string) => (
    <label className={styles.inline}>
      <span>{t(label)}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={watermark[key]}
        onChange={(e) => set({ [key]: Number(e.target.value) } as Partial<WatermarkSettings>)}
        data-testid={`export-wm-${key}`}
      />
      <span className={`${styles.value} mono`}>
        {watermark[key]}
        {unit}
      </span>
    </label>
  )

  return (
    <section className={styles.group}>
      <label className={styles.check}>
        <input type="checkbox" checked={watermark.enabled} onChange={(e) => set({ enabled: e.target.checked })} data-testid="export-wm" />
        <span>{t('batch.export.wm')}</span>
      </label>
      {watermark.enabled && (
        <div className={styles.wmFields}>
          <label className={styles.inline}>
            <span>{t('batch.export.wm.text')}</span>
            <input className={styles.text} value={watermark.text} maxLength={200} onChange={(e) => set({ text: e.target.value })} data-testid="export-wm-text" />
          </label>
          {!watermark.text.trim() && <p className={styles.fieldProblem}>{t('batch.export.wm.needText')}</p>}
          <label className={styles.inline}>
            <span>{t('batch.export.wm.position')}</span>
            <select className={styles.select} value={watermark.position} onChange={(e) => set({ position: e.target.value as WatermarkPosition })}>
              {WATERMARK_POSITIONS.map((position) => (
                <option key={position} value={position}>
                  {t(POSITION_LABEL[position])}
                </option>
              ))}
            </select>
          </label>
          {number('opacity', 1, 100, 'batch.export.wm.opacity', '%')}
          {number('size_percent', 1, 20, 'batch.export.wm.size', '%')}
          {number('margin_percent', 0, 10, 'batch.export.wm.margin', '%')}
          <label className={styles.inline}>
            <span>{t('batch.export.wm.color')}</span>
            <input type="color" className={styles.color} value={watermark.color.toLowerCase()} onChange={(e) => set({ color: e.target.value.toUpperCase() })} />
            <span className={`${styles.value} mono`}>{watermark.color}</span>
          </label>
        </div>
      )}
    </section>
  )
}
