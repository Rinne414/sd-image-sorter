import { useRef, useState, type ChangeEvent } from 'react'
import { useT } from '../../../i18n'
import { Dialog } from '../../../ui/Dialog'
import { useToasts } from '../../../ui/toasts'
import { Section } from '../about/Section'
import { useLT } from '../libraryText'
import { exportTags, importTags } from './libraryApi'
import styles from './LibrarySettings.module.css'
import { readTagFile, type TagFile } from './tagBackup'

type ReadFile = Extract<TagFile, { ok: true }> & { name: string }

/** Tag backup: every tagged image's tags and AI description to a JSON file, and back (saying first how many it can change). */
export function TagBackupSection() {
  const t = useLT()
  const input = useRef<HTMLInputElement>(null)
  const [exporting, setExporting] = useState(false)
  const [file, setFile] = useState<ReadFile | null>(null)

  const doExport = async () => {
    setExporting(true)
    await exportTags()
    setExporting(false)
  }

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0]
    e.target.value = ''
    if (!picked) return
    const read = readTagFile(await picked.text())
    if (!read.ok) {
      useToasts.getState().push(t(read.reason === 'json' ? 'libset.tags.notJson' : 'libset.tags.badShape'), 'error')
      return
    }
    setFile({ ...read, name: picked.name })
  }

  return (
    <Section title={t('libset.tags.title')} testId="libset-tags">
      <p className={styles.lead}>{t('libset.tags.hint')}</p>
      <div className={styles.row}>
        <button type="button" className="btn" onClick={() => void doExport()} disabled={exporting} data-testid="tags-export">
          {exporting ? t('libset.tags.exporting') : t('libset.tags.export')}
        </button>
        <button type="button" className="btn" onClick={() => input.current?.click()} data-testid="tags-import">
          {t('libset.tags.import')}
        </button>
        <input ref={input} type="file" accept=".json,application/json" hidden onChange={(e) => void onPick(e)} data-testid="tags-import-file" />
      </div>
      {file && <ImportDialog file={file} onClose={() => setFile(null)} />}
    </Section>
  )
}

function ImportDialog({ file, onClose }: { file: ReadFile; onClose: () => void }) {
  const t = useLT()
  const tm = useT()
  const [overwrite, setOverwrite] = useState(false)
  const [busy, setBusy] = useState(false)

  const go = async () => {
    setBusy(true)
    const ok = await importTags(file.images, overwrite)
    setBusy(false)
    if (ok) onClose()
  }

  const footer = (
    <>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        {tm('common.cancel')}
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void go()} disabled={busy || file.usable === 0} data-testid="tags-import-ok">
        {t('libset.import.ok', { n: file.usable })}
      </button>
    </>
  )

  return (
    <Dialog title={t('libset.import.title')} onClose={onClose} footer={footer} testId="tags-import-dialog">
      <div className={styles.dialogText}>
        <p className={styles.file}>{t('libset.import.file', { name: file.name })}</p>
        <p className={styles.strong} data-testid="tags-import-counts">
          {file.usable > 0 ? t('libset.import.counts', { total: file.total, usable: file.usable, empty: file.empty }) : t('libset.import.nothing')}
        </p>
        <p className={styles.muted}>{t('libset.import.match')}</p>
        {file.usable > 0 && (
          <fieldset className={styles.choices} aria-label={t('libset.import.title')}>
            <label className={styles.choice}>
              <input type="radio" name="tags-import-mode" checked={!overwrite} onChange={() => setOverwrite(false)} />
              <span>{t('libset.import.fill')}</span>
              <span>{t('libset.import.fillHint')}</span>
            </label>
            <label className={styles.choice}>
              <input type="radio" name="tags-import-mode" checked={overwrite} onChange={() => setOverwrite(true)} />
              <span>{t('libset.import.replace')}</span>
              <span>{t('libset.import.replaceHint')}</span>
            </label>
          </fieldset>
        )}
      </div>
    </Dialog>
  )
}
