import { useEffect, useState } from 'react'
import { useT } from '../../../../i18n'
import { FolderChooser } from '../../../../ui/FolderChooser'
import { recentFolders, rememberFolder } from '../../../batch/recentFolders'
import privacy from '../Privacy.module.css'
import { defaultCoverUrl } from './disguiseApi'
import { COVER_KINDS, type CoverKind } from './disguiseModel'
import { chooseDefaultCover, pickImage, refreshDefaultCover, removeDefaultCover, setDefaultCover, setDisguise, setUploadCover, useDisguise } from './disguiseStore'
import styles from './Disguise.module.css'

// The chat disguise's controls in the left column: which cover, packing, and
// (folded under Advanced) cleaning, size and where the files go.

const FOLDERS_KEY = 'sd-v4-recent-disguise-folders'

type TKey = ReturnType<typeof useT>

const COVER_LABEL = {
  default: 'disguise.cover.default',
  mosaic: 'disguise.cover.mosaic',
  text: 'disguise.cover.text',
  blur: 'disguise.cover.blur',
  upload: 'disguise.cover.upload',
} as const satisfies Record<CoverKind, Parameters<TKey>[0]>

/** A number field that keeps what is being typed; only a valid number is saved. */
function NumberField({ value, onValid, valid, step, min, testId, label }: { value: number; onValid: (n: number) => void; valid: (n: number) => boolean; step: number; min: number; testId: string; label: string }) {
  const [draft, setDraft] = useState(String(value))
  return (
    <input
      className={styles.number}
      type="number"
      min={min}
      step={step}
      value={draft}
      aria-label={label}
      onChange={(e) => {
        setDraft(e.target.value)
        const n = Number(e.target.value)
        if (e.target.value.trim() !== '' && Number.isFinite(n) && valid(n)) onValid(n)
      }}
      onBlur={() => setDraft(String(value))}
      data-testid={testId}
    />
  )
}

function DefaultCoverRow() {
  const t = useT()
  const info = useDisguise((s) => s.defaultCover)
  return (
    <div className={styles.extra}>
      {info?.exists ? <img className={styles.thumb} src={defaultCoverUrl(info.version)} alt={t('disguise.cover.defaultAlt')} data-testid="disguise-default-thumb" /> : <span className={privacy.hint} data-testid="disguise-default-empty">{t('disguise.cover.noDefault')}</span>}
      <button type="button" className="btn" onClick={() => void chooseDefaultCover()} data-testid="disguise-default-set">
        {t('disguise.cover.setDefault')}
      </button>
      {info?.exists && (
        <button type="button" className="btn btn-ghost" onClick={() => void removeDefaultCover()} data-testid="disguise-default-clear">
          {t('disguise.cover.clearDefault')}
        </button>
      )}
    </div>
  )
}

function UploadCoverRow() {
  const t = useT()
  const cover = useDisguise((s) => s.uploadCover)
  return (
    <div className={styles.extra}>
      {cover && <img className={styles.thumb} src={cover.url} alt={t('disguise.cover.uploadAlt')} data-testid="disguise-upload-thumb" />}
      <button type="button" className="btn" onClick={() => void pickImage().then((file) => file && setUploadCover(file))} data-testid="disguise-upload-pick">
        {t('disguise.cover.choose')}
      </button>
      {cover && (
        <button type="button" className="btn btn-ghost" onClick={() => void setDefaultCover(cover.file)} data-testid="disguise-upload-as-default">
          {t('disguise.cover.useAsDefault')}
        </button>
      )}
    </div>
  )
}

function TextCardRow() {
  const t = useT()
  const s = useDisguise((st) => st.settings)
  return (
    <div className={styles.extra}>
      <input
        className={styles.input}
        type="text"
        value={s.coverText}
        placeholder={t('disguise.cover.textPlaceholder')}
        aria-label={t('disguise.cover.textLabel')}
        onChange={(e) => setDisguise({ coverText: e.target.value })}
        data-testid="disguise-text-input"
      />
      <input className={styles.color} type="color" value={s.coverBg} title={t('disguise.cover.cardColor')} aria-label={t('disguise.cover.cardColor')} onChange={(e) => setDisguise({ coverBg: e.target.value })} data-testid="disguise-text-bg" />
      <input className={styles.color} type="color" value={s.coverFg} title={t('disguise.cover.textColor')} aria-label={t('disguise.cover.textColor')} onChange={(e) => setDisguise({ coverFg: e.target.value })} data-testid="disguise-text-fg" />
    </div>
  )
}

function CoverField() {
  const t = useT()
  const kind = useDisguise((s) => s.settings.coverKind)
  const pack = useDisguise((s) => s.settings.pack && s.settings.packFormat === 'gif')
  if (pack) return null
  return (
    <div className={privacy.field}>
      <label className={privacy.subLabel} htmlFor="disguise-cover-kind">
        {t('disguise.cover')}
      </label>
      <select id="disguise-cover-kind" className={styles.select} value={kind} onChange={(e) => setDisguise({ coverKind: e.target.value as CoverKind })} data-testid="disguise-cover-kind">
        {COVER_KINDS.map((k) => (
          <option key={k} value={k}>
            {t(COVER_LABEL[k])}
          </option>
        ))}
      </select>
      {kind === 'default' && <DefaultCoverRow />}
      {kind === 'upload' && <UploadCoverRow />}
      {kind === 'text' && <TextCardRow />}
      {kind === 'mosaic' && <span className={privacy.hint}>{t('disguise.cover.mosaicNote')}</span>}
      {kind === 'blur' && <span className={privacy.hint}>{t('disguise.cover.blurNote')}</span>}
    </div>
  )
}

function PackField() {
  const t = useT()
  const s = useDisguise((st) => st.settings)
  return (
    <div className={privacy.field}>
      <label className={privacy.check}>
        <input type="checkbox" checked={s.pack} onChange={(e) => setDisguise({ pack: e.target.checked })} data-testid="disguise-pack" />
        <span>
          <span className={privacy.modeName}>{t('disguise.pack')}</span>
        </span>
      </label>
      {s.pack && (
        <div className={styles.inline}>
          <label className={styles.inlineLabel}>
            <span>{t('disguise.seconds')}</span>
            <NumberField value={s.frameSeconds} onValid={(frameSeconds) => setDisguise({ frameSeconds })} valid={(n) => n > 0} step={0.1} min={0.1} testId="disguise-frame-seconds" label={t('disguise.seconds')} />
          </label>
          <label className={styles.inlineLabel}>
            <span>{t('disguise.packFormat')}</span>
            <select className={styles.select} value={s.packFormat} onChange={(e) => setDisguise({ packFormat: e.target.value === 'gif' ? 'gif' : 'disguise' })} data-testid="disguise-pack-format">
              <option value="disguise">{t('disguise.packFormat.disguise')}</option>
              <option value="gif">{t('disguise.packFormat.gif')}</option>
            </select>
          </label>
        </div>
      )}
    </div>
  )
}

/** The part of the settings shown for a chat disguise (the cover and packing). */
export function DisguiseSettings() {
  const t = useT()
  const known = useDisguise((s) => s.defaultCover !== null)
  useEffect(() => {
    if (!known) void refreshDefaultCover()
  }, [known])
  return (
    <>
      <CoverField />
      <PackField />
      <p className={privacy.hint}>{t('disguise.local')}</p>
    </>
  )
}

/** Cleaning, size and the save folder: folded under Advanced. */
export function DisguiseAdvanced() {
  const t = useT()
  const s = useDisguise((st) => st.settings)
  const [choosing, setChoosing] = useState(false)
  return (
    <div className={styles.advanced}>
      <label className={privacy.check}>
        <input type="checkbox" checked={s.scrub} onChange={(e) => setDisguise({ scrub: e.target.checked })} data-testid="disguise-scrub" />
        <span>
          <span className={privacy.modeName}>{t('disguise.scrub')}</span>
          <span className={privacy.hint}>{t('disguise.scrub.hint')}</span>
        </span>
      </label>
      <label className={styles.inlineLabel}>
        <span>{t('disguise.maxSide')}</span>
        <NumberField value={s.maxSide} onValid={(maxSide) => setDisguise({ maxSide })} valid={(n) => Number.isInteger(n) && n >= 0} step={100} min={0} testId="disguise-max-side" label={t('disguise.maxSide')} />
      </label>
      <div className={privacy.field}>
        <label className={privacy.subLabel} htmlFor="disguise-output-folder">
          {t('disguise.folder')}
        </label>
        <div className={styles.folderRow}>
          <input id="disguise-output-folder" className={styles.input} type="text" value={s.outputFolder} placeholder={t('disguise.folder.placeholder')} spellCheck={false} onChange={(e) => setDisguise({ outputFolder: e.target.value })} data-testid="disguise-output-folder" />
          <button type="button" className="btn" onClick={() => setChoosing(true)} data-testid="disguise-folder-choose">
            {t('disguise.folder.choose')}
          </button>
        </div>
      </div>
      {choosing && (
        <FolderChooser
          title={t('disguise.folder.chooseTitle')}
          confirmLabel={t('disguise.folder.chooseOk')}
          start={s.outputFolder || recentFolders(FOLDERS_KEY)[0] || null}
          shortcuts={[{ heading: t('batch.export.recentFolders'), paths: recentFolders(FOLDERS_KEY) }]}
          onChoose={async (target) => {
            setDisguise({ outputFolder: target })
            rememberFolder(FOLDERS_KEY, target)
            return true
          }}
          onClose={() => setChoosing(false)}
          testId="disguise-folder-picker"
        />
      )}
    </div>
  )
}
