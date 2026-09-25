import { useMemo, useState } from 'react'
import { useFolders } from '../../api/queries'
import { useT } from '../../i18n'
import { FolderChooser } from '../../ui/FolderChooser'
import { useSelectionDialog } from '../selection/dialogs'
import styles from './ImportDialog.module.css'
import { recentImports, startImport, type ImportOptions } from './importJob'

const START: ImportOptions = { recursive: true, forceReparse: false, cleanupMissing: false, verifyFiles: false }

/** Pick a folder to import; the everyday option is visible, the slower ones fold away. */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [o, setO] = useState<ImportOptions>(START)
  const recent = useMemo(recentImports, [])
  const hint = useSelectionDialog((s) => s.hint)
  const folders = useFolders()
  // The library's own top folders are where re-imports usually go.
  const libraryFolders = (folders.data ?? []).slice(0, 5)

  const extra = (
    <div className={styles.options}>
      <label className={styles.check}>
        <input type="checkbox" checked={o.recursive} onChange={(e) => setO({ ...o, recursive: e.target.checked })} />
        {t('import.recursive')}
      </label>
      <details className={styles.advanced}>
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
      onChoose={(folder) => startImport(folder, o)}
      onClose={onClose}
      testId="import-dialog"
      extra={extra}
    />
  )
}
