import { useMemo, useState } from 'react'
import { useT, type MessageKey } from '../../../i18n'
import { FolderChooser } from '../../../ui/FolderChooser'
import type { ProjectSettings } from '../datasetSettings'
import pix from '../ExportStep.module.css'
import { recentFolders, rememberFolder } from '../recentFolders'
import styles from './DatasetExport.module.css'
import { FORMATS, formatOf, namingPattern, optionBlock, sampleName, type ExportFormat, type FormatNote, type NamingPreset } from './plan'
import { BLOCK_KEY } from './texts'
import type { ExportOptions } from './useExportOptions'

const RECENT_KEY = 'sd-v4-recent-dataset-folders'

const FORMAT_NOTE: Record<ExportFormat, MessageKey> = {
  kohya: 'dataset.export.format.kohyaNote',
  anima: 'dataset.export.format.animaNote',
  folder: 'dataset.export.format.folderNote',
  beside: 'dataset.export.format.besideNote',
}
const NOTE_KEY: Record<FormatNote, MessageKey> = {
  bucketOff: 'dataset.export.note.bucketOff',
  watermarkOff: 'dataset.export.note.watermarkOff',
  maskReset: 'dataset.export.note.maskReset',
  outputCopy: 'dataset.export.note.outputCopy',
  resolution1024: 'dataset.export.note.resolution1024',
  keepTokens0: 'dataset.export.note.keepTokens0',
  cropOff: 'dataset.export.note.cropOff',
}
const PRESETS: readonly NamingPreset[] = ['keep', 'renumber', 'custom']
const POLICIES: readonly ProjectSettings['output']['overwrite_policy'][] = ['unique', 'overwrite', 'skip']

interface Props {
  o: ExportOptions
  s: ProjectSettings
  /** First image's file name, for the example output name. */
  firstName: string | null
}

/** What kind of export, where it goes, and how the files are named and written. */
export function FilesFields({ o, s, firstName }: Props) {
  const format = formatOf(s)
  return (
    <>
      <FormatField o={o} format={format} />
      {format === 'beside' ? <BesideNote /> : <FolderField o={o} s={s} />}
      <NamingField o={o} s={s} firstName={firstName} beside={format === 'beside'} />
    </>
  )
}

function FormatField({ o, format }: { o: ExportOptions; format: ExportFormat }) {
  const t = useT()
  return (
    <section className={pix.group} role="radiogroup" aria-label={t('dataset.export.format')}>
      <h3 className={pix.groupTitle}>{t('dataset.export.format')}</h3>
      <div className={styles.formats}>
        {FORMATS.map((f) => (
          <label key={f} className={pix.choice} data-option={f}>
            <input type="radio" name="ds-export-format" checked={format === f} onChange={() => o.setFormat(f)} data-testid={`ds-format-${f}`} />
            <span className={pix.choiceText}>
              <span>{t(`dataset.export.format.${f}` as MessageKey)}</span>
              <span className={pix.choiceNote}>{t(FORMAT_NOTE[f])}</span>
            </span>
          </label>
        ))}
      </div>
      {o.notes.length > 0 && (
        <p className={styles.note} data-tone="warn" role="status" data-testid="ds-format-notes">
          {o.notes.map((n) => t(NOTE_KEY[n])).join(t('batch.listSep'))}
        </p>
      )}
    </section>
  )
}

function BesideNote() {
  const t = useT()
  return (
    <section className={pix.group}>
      <h3 className={pix.groupTitle}>{t('batch.export.folder')}</h3>
      <p className={styles.note} data-tone="warn" data-testid="ds-beside-note">
        {t('dataset.export.besideWarn')}
      </p>
    </section>
  )
}

function FolderField({ o, s }: { o: ExportOptions; s: ProjectSettings }) {
  const t = useT()
  const [choosing, setChoosing] = useState(false)
  const recent = useMemo(() => recentFolders(RECENT_KEY), [choosing])
  const folder = s.output.folder
  return (
    <section className={pix.group}>
      <h3 className={pix.groupTitle}>{t('batch.export.folder')}</h3>
      <div className={pix.folderRow}>
        <span className={`${pix.folder} mono`} data-empty={!folder || undefined} data-testid="ds-export-folder" title={folder}>
          {folder || t('batch.export.folderNone')}
        </span>
        <button type="button" className="btn" onClick={() => setChoosing(true)} data-testid="ds-export-choose-folder">
          {t('batch.export.chooseFolder')}
        </button>
      </div>
      <p className={styles.note}>{t('dataset.export.folderHint')}</p>
      {choosing && (
        <FolderChooser
          title={t('batch.export.chooseTitle')}
          confirmLabel={t('batch.export.chooseOk')}
          start={folder || recent[0] || null}
          shortcuts={[{ heading: t('batch.export.recentFolders'), paths: recent, testId: 'ds-export-recent' }]}
          onChoose={async (target) => {
            o.update((cur) => ({ ...cur, output: { ...cur.output, folder: target } }))
            rememberFolder(RECENT_KEY, target)
            return true
          }}
          onClose={() => setChoosing(false)}
          testId="ds-export-folder-picker"
        />
      )}
    </section>
  )
}

function NamingField({ o, s, firstName, beside }: Props & { beside: boolean }) {
  const t = useT()
  const trigger = s.caption_render.trigger
  const pattern = namingPattern(s.naming, trigger)
  const sample = firstName ? sampleName(beside ? '{filename}' : pattern, { filename: firstName, index: 1, trigger }) : null
  const stem = sample ? sample.replace(/\.[^.]+$/, '') : ''
  const moveBlock = optionBlock('move', s, 0)
  const setNaming = (change: Partial<ProjectSettings['naming']>) => o.update((cur) => ({ ...cur, naming: { ...cur.naming, ...change } }))
  const setOutput = (change: Partial<ProjectSettings['output']>) => o.update((cur) => ({ ...cur, output: { ...cur.output, ...change } }))
  return (
    <section className={pix.group}>
      <h3 className={pix.groupTitle}>{t('dataset.export.files')}</h3>
      {!beside && (
        <div className={styles.row} role="radiogroup" aria-label={t('dataset.export.naming')}>
          <span>{t('dataset.export.naming')}</span>
          {PRESETS.map((p) => (
            <label key={p} className={pix.check}>
              <input type="radio" name="ds-naming" checked={s.naming.preset === p} onChange={() => setNaming({ preset: p })} data-testid={`ds-naming-${p}`} />
              <span>{t(`dataset.export.naming.${p}` as MessageKey)}</span>
            </label>
          ))}
          {s.naming.preset === 'custom' && (
            <input
              className={styles.pattern}
              value={s.naming.custom_pattern}
              maxLength={200}
              spellCheck={false}
              aria-label={t('dataset.export.naming.pattern')}
              onChange={(e) => setNaming({ custom_pattern: e.target.value || '{index:03d}' })}
              data-testid="ds-naming-pattern"
            />
          )}
        </div>
      )}
      {sample && (
        <p className={styles.sample} data-testid="ds-sample-name">
          {t('dataset.export.sample')} <b className="mono">{sample}</b> + <b className="mono">{stem}.txt</b>
        </p>
      )}
      {!beside && (
        <div className={styles.row} role="radiogroup" aria-label={t('dataset.export.imageOp')}>
          <span>{t('dataset.export.imageOp')}</span>
          {(['copy', 'move'] as const).map((op) => (
            <label key={op} className={pix.check}>
              <input
                type="radio"
                name="ds-image-op"
                checked={s.output.image_op === op}
                disabled={op === 'move' && moveBlock !== null && s.output.image_op !== 'move'}
                onChange={() => setOutput({ image_op: op })}
                data-testid={`ds-op-${op}`}
              />
              <span>{t(`dataset.export.op.${op}` as MessageKey)}</span>
            </label>
          ))}
        </div>
      )}
      {!beside && s.output.image_op === 'move' && <p className={styles.note} data-tone="warn">{t('dataset.export.op.moveWarn')}</p>}
      {!beside && moveBlock && s.output.image_op === 'copy' && (
        <p className={styles.why}>{t(moveBlock === 'package' ? 'dataset.export.block.movePackage' : BLOCK_KEY[moveBlock])}</p>
      )}
      <label className={pix.inline}>
        <span>{t('dataset.export.collision')}</span>
        <select
          className={pix.select}
          value={s.output.overwrite_policy}
          onChange={(e) => setOutput({ overwrite_policy: e.target.value as ProjectSettings['output']['overwrite_policy'] })}
          data-testid="ds-collision"
        >
          {POLICIES.map((p) => (
            <option key={p} value={p}>
              {t(`dataset.export.collision.${p}` as MessageKey)}
            </option>
          ))}
        </select>
      </label>
    </section>
  )
}
