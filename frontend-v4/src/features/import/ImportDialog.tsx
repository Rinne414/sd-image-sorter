import { useMemo, useState } from 'react'
import { useFolders, useLibraryHealth } from '../../api/queries'
import { useT } from '../../i18n'
import { FolderChooser } from '../../ui/FolderChooser'
import { pasteFromClipboard } from '../collect/collectActions'
import { useSelectionDialog } from '../selection/dialogs'
import styles from './ImportDialog.module.css'
import { recentImports, startImport, storedRestoreDisguised, storeRestoreDisguised, type ImportOptions } from './importJob'

const START: Omit<ImportOptions, 'restoreDisguised'> = { recursive: true, forceReparse: false, cleanupMissing: false, verifyFiles: false, tagAfter: false }

/** Pick a folder to import; the everyday option is visible, the slower ones fold away. */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [o, setO] = useState<ImportOptions>(() => ({ ...START, restoreDisguised: storedRestoreDisguised() }))
  // A remembered "restore disguises" opens the advanced options so the tick is seen.
  const [advancedOpen] = useState(o.restoreDisguised)
  const recent = useMemo(recentImports, [])
  const hint = useSelectionDialog((s) => s.hint)
  const folders = useFolders()
  const health = useLibraryHealth()
  const untagged = health.data?.issue_counts.untagged ?? 0
  // The library's own top folders are where re-imports usually go.
  const libraryFolders = (folders.data ?? []).slice(0, 5)

  const extra = (
    <div className={styles.options}>
      <div className={styles.paste}>
        <span className={styles.hint}>{t('collect.paste.rowHint')}</span>
        <button type="button" className="btn" onClick={() => void pasteFromClipboard()} data-testid="import-paste-picture">
          {t('collect.paste.button')}
        </button>
      </div>
      <label className={styles.check}>
        <input type="checkbox" checked={o.recursive} onChange={(e) => setO({ ...o, recursive: e.target.checked })} />
        {t('import.recursive')}
      </label>
      <details className={styles.advanced} open={advancedOpen}>
        <summary>{t('tagging.advanced')}</summary>
        <label className={styles.check}>
          <input type="checkbox" checked={o.forceReparse} onChange={(e) => setO({ ...o, forceReparse: e.target.checked })} />
          {t('import.forceReparse')}
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={o.verifyFiles} onChange={(e) => setO({ ...o, verifyFiles: e.target.checked })} />
          {t('import.verifyFiles')}
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={o.cleanupMissing} onChange={(e) => setO({ ...o, cleanupMissing: e.target.checked })} />
          {t('import.cleanupMissing')}
        </label>
        {o.cleanupMissing && <p className={styles.warn}>{t('import.cleanupWarn')}</p>}
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={o.restoreDisguised}
            onChange={(e) => {
              storeRestoreDisguised(e.target.checked)
              setO({ ...o, restoreDisguised: e.target.checked })
            }}
            data-testid="import-restore-disguised"
          />
          {t('import.restoreDisguised')}
        </label>
        <p className={styles.indented}>{t('import.restoreDisguisedHint')}</p>
        <label className={styles.check}>
          <input type="checkbox" checked={o.tagAfter} onChange={(e) => setO({ ...o, tagAfter: e.target.checked })} data-testid="import-tag-after" />
          {t('import.tagAfter')}
        </label>
        {o.tagAfter && <p className={styles.hint}>{t('import.tagAfterCount', { n: untagged })}</p>}
        <p className={styles.hint}>{t('import.storageHint')}</p>
      </details>
    </div>
  )

  return (
    <FolderChooser
      title={t('import.title')}
      confirmLabel={t('import.start')}
      start={hint ?? recent[0] ?? null}
      shortcuts={[
        { heading: t('picker.recent'), paths: recent, testId: 'import-recent' },
        { heading: t('import.libraryFolders'), paths: libraryFolders },
      ]}
      allowNewFolder={false}
      onChoose={(folder) => startImport(folder, o, untagged)}
      onClose={onClose}
      testId="import-dialog"
      extra={extra}
    />
  )
}
