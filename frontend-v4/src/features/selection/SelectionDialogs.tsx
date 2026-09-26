import { useMemo, useRef, useState } from 'react'
import { loadedNames } from '../../api/loaded'
import { useLang, useT } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { startFileJob } from '../jobs/fileJobs'
import { TagDialog } from '../tagging/TagDialog'
import { TagEditDialog } from '../tagedit/TagEditDialog'
import { ExportDataDialog } from '../exportdata/ExportDataDialog'
import { MissingDialog } from '../status/MissingDialog'
import { ImportDialog } from '../import/ImportDialog'
import { LibrariesDialog, MoveToLibraryDialog } from '../libraries/LibrariesDialog'
import { useSelectionDialog } from './dialogs'
import { FolderPicker } from './FolderPicker'
import styles from './SelectionDialogs.module.css'

/** Mounts whichever selection dialog is open. */
export function SelectionDialogs() {
  const open = useSelectionDialog((s) => s.open)
  const ids = useSelectionDialog((s) => s.ids)
  const count = useSelectionDialog((s) => s.count)
  const close = useSelectionDialog((s) => s.close)
  if (!open || count === 0) return null
  if (open === 'tag') return <TagDialog ids={ids} count={count} onClose={close} />
  if (open === 'missing') return <MissingDialog onClose={close} />
  if (open === 'import') return <ImportDialog onClose={close} />
  if (open === 'libraries' || open === 'new-library') return <LibrariesDialog creating={open === 'new-library'} onClose={close} />
  if (!ids) return null
  if (open === 'describe') return <TagDialog ids={ids} count={count} onClose={close} mode="describe" />
  if (open === 'move' || open === 'copy') return <FolderPicker operation={open} ids={ids} onClose={close} />
  if (open === 'move-library') return <MoveToLibraryDialog ids={ids} onClose={close} />
  if (open === 'edit-tags') return <TagEditDialog ids={ids} onClose={close} />
  if (open === 'export') return <ExportDataDialog ids={ids} onClose={close} />
  return <ConfirmFileAction kind={open} ids={ids} onClose={close} />
}

const EXAMPLES = 3

/** Remove from library / move to Trash. Both lose ratings and tags, so Cancel has the focus. */
function ConfirmFileAction({ kind, ids, onClose }: { kind: 'remove' | 'trash'; ids: number[]; onClose: () => void }) {
  const t = useT()
  const lang = useLang((s) => s.lang)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [starting, setStarting] = useState(false)
  const names = useMemo(() => loadedNames(ids, EXAMPLES), [ids])
  const n = ids.length
  const trash = kind === 'trash'

  const go = async () => {
    setStarting(true)
    const ok = await startFileJob(kind, ids)
    setStarting(false)
    if (ok) onClose()
  }

  const examples = names.join(lang === 'zh-CN' ? '、' : ', ') + (n > names.length ? ' …' : '')

  return (
    <Dialog
      title={t(trash ? 'confirm.trashTitle' : 'confirm.removeTitle', { n })}
      onClose={onClose}
      testId="confirm-dialog"
      initialFocus={cancelRef}
      footer={
        <>
          <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void go()} disabled={starting}>
            {t(trash ? 'confirm.trashOk' : 'confirm.removeOk', { n })}
          </button>
        </>
      }
    >
      <p className={styles.body}>{t(trash ? 'confirm.trashBody' : 'confirm.removeBody')}</p>
      {names.length > 0 && <p className={styles.examples}>{t('confirm.examples', { names: examples })}</p>}
    </Dialog>
  )
}
