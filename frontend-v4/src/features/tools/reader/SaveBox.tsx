import { useState } from 'react'
import { joinFolder, parentFolder, tailOfPath } from '../../../lib/paths'
import { FolderChooser } from '../../../ui/FolderChooser'
import { useTT } from '../toolText'
import styles from './Reader.module.css'
import { editedName, formatOf, SAVE_FORMATS, withFormat, type SaveFormat } from './metadataForm'
import { ReplaceDialog, SaveResult } from './SaveParts'
import type { Saved } from './saveFlows'

// "Save as new image": the format, the file name and the folder (chosen by
// browsing, remembered for next time), and what the last save said.

const DIR_KEY = 'sd-v4-reader-save-dir'

function rememberedFolder(): string {
  try {
    return localStorage.getItem(DIR_KEY) ?? ''
  } catch {
    return ''
  }
}

function rememberFolder(folder: string): void {
  try {
    localStorage.setItem(DIR_KEY, folder)
  } catch {
    // storage blocked: the folder is asked for again next time
  }
}

/** Where a copy of this image goes: the new file, and whether a file already there may be replaced. */
export interface SaveTarget {
  outputPath: string
  format: SaveFormat
  replace: boolean
}

interface Props {
  /** The name the copy is called after. */
  name: string
  /** A library image's own file (its folder is the default; saving onto it is an overwrite). */
  libraryPath: string | null
  busy: boolean
  saved: Saved | null
  /** Save; 'exists' asks before replacing. */
  onSave: (target: SaveTarget) => Promise<'exists' | 'done' | 'failed'>
}

function FormatAndName({ format, name, onFormat, onName }: { format: SaveFormat; name: string; onFormat: (f: SaveFormat) => void; onName: (n: string) => void }) {
  const t = useTT()
  return (
    <>
      <div className={styles.saveRow}>
        <label className={styles.field}>
          <span>{t('reader.edit.format')}</span>
          <select value={format} onChange={(e) => onFormat(e.target.value as SaveFormat)} data-testid="reader-edit-format">
            {SAVE_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label className={`${styles.field} ${styles.grow}`}>
          <span>{t('reader.edit.name')}</span>
          <input value={name} onChange={(e) => onName(e.target.value)} spellCheck={false} data-testid="reader-edit-name" />
        </label>
      </div>
      {format !== 'png' && <p className={styles.warnText}>{t(format === 'jpg' ? 'reader.edit.jpgNote' : 'reader.edit.webpNote')}</p>}
    </>
  )
}

export function SaveBox({ name: sourceName, libraryPath, busy, saved, onSave }: Props) {
  const t = useTT()
  const first = formatOf(sourceName) ?? 'png'
  const [format, setFormat] = useState<SaveFormat>(first)
  const [name, setName] = useState(() => editedName(sourceName, first))
  const [folder, setFolder] = useState(() => (libraryPath ? (parentFolder(libraryPath) ?? '') : rememberedFolder()))
  const [dialog, setDialog] = useState<'folder' | 'replace' | null>(null)
  const outputPath = folder && name.trim() ? joinFolder(folder, name.trim()) : ''

  const save = async (replace: boolean) => {
    rememberFolder(folder)
    if ((await onSave({ outputPath, format, replace })) === 'exists') setDialog('replace')
  }

  return (
    <div className={styles.saveBox}>
      <FormatAndName
        format={format}
        name={name}
        onFormat={(f) => {
          setFormat(f)
          setName((n) => withFormat(n, f))
        }}
        onName={setName}
      />
      <div className={styles.folderRow}>
        <span className={styles.subLabel}>{t('reader.edit.folder')}</span>
        <span className={`${styles.folderPath} mono`} title={folder} data-testid="reader-edit-folder">
          {folder ? tailOfPath(folder, 64) : t('reader.edit.noFolder')}
        </span>
        <button type="button" className="btn" onClick={() => setDialog('folder')} data-testid="reader-edit-choose">
          {t('reader.edit.chooseFolder')}
        </button>
      </div>
      <button type="button" className="btn btn-primary" onClick={() => void save(false)} disabled={busy || !outputPath} data-testid="reader-save-as">
        {t('reader.edit.saveAs')}
      </button>
      {saved && <SaveResult saved={saved} />}

      {dialog === 'folder' && (
        <FolderChooser
          title={t('reader.edit.folderTitle')}
          confirmLabel={t('reader.edit.folderConfirm')}
          start={folder || null}
          shortcuts={[
            { heading: t('reader.edit.folderSource'), paths: libraryPath ? [parentFolder(libraryPath) ?? ''].filter(Boolean) : [] },
            { heading: t('reader.edit.folderLast'), paths: [rememberedFolder()].filter(Boolean) },
          ]}
          onChoose={async (target) => {
            setFolder(target)
            return true
          }}
          onClose={() => setDialog(null)}
          testId="reader-folder-picker"
        />
      )}
      {dialog === 'replace' && (
        <ReplaceDialog
          path={outputPath}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null)
            void save(true)
          }}
        />
      )}
    </div>
  )
}
