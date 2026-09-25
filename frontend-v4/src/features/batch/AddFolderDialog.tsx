import { useMemo, useState } from 'react'
import { useT } from '../../i18n'
import { FolderChooser } from '../../ui/FolderChooser'
import styles from '../import/ImportDialog.module.css'
import { addFromFolder, useFolderDialog } from './datasetImport'

const RECENT_KEY = 'sd-v4-dataset-folders'
const RECENT_MAX = 6

function recentFolders(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

function remember(folder: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([folder, ...recentFolders().filter((p) => p !== folder)].slice(0, RECENT_MAX)))
  } catch {
    // storage blocked: the list just stays short
  }
}

/** Add a folder's images to a dataset batch by path: nothing is copied, nothing enters the Library. */
export function AddFolderDialog({ batchId }: { batchId: number }) {
  const t = useT()
  const open = useFolderDialog((s) => s.batchId === batchId)
  const start = useFolderDialog((s) => s.start)
  const [recursive, setRecursive] = useState(true)
  const recent = useMemo(() => (open ? recentFolders() : []), [open])
  if (!open) return null

  const close = () => useFolderDialog.setState({ batchId: null, start: null })
  const choose = async (folder: string) => {
    const ok = await addFromFolder(batchId, folder, recursive)
    if (ok) remember(folder)
    return ok
  }

  const extra = (
    <div className={styles.options}>
      <label className={styles.check}>
        <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} data-testid="dataset-folder-recursive" />
        {t('import.recursive')}
      </label>
      <p className={styles.hint}>{t('dataset.folderNote')}</p>
    </div>
  )

  return (
    <FolderChooser
      title={t('dataset.folderTitle')}
      confirmLabel={t('dataset.folderAdd')}
      start={start ?? recent[0] ?? null}
      shortcuts={[{ heading: t('picker.recent'), paths: recent, testId: 'dataset-folder-recent' }]}
      allowNewFolder={false}
      onChoose={choose}
      onClose={close}
      testId="dataset-folder-dialog"
      extra={extra}
      targetLabel={t('dataset.folderChosen')}
    />
  )
}
