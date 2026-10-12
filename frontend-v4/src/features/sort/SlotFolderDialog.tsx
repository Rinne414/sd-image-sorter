import { useMemo } from 'react'
import { useT } from '../../i18n'
import { FolderChooser } from '../../ui/FolderChooser'
import { recentDestinations, rememberDestination } from '../selection/dialogs'
import type { SlotKey } from './sortSession'

interface Props {
  slot: SlotKey
  /** The key's folder now, if it has one: the chooser opens there. */
  current: string | null
  /** Where the images to sort live (the first one's folder), when known. */
  sourceFolder: string | null
  onChoose: (path: string) => Promise<boolean>
  onClose: () => void
  /** Instead of "Folder for images sent with W" (sort by condition has no keys). */
  title?: string
}

/** Choose the folder behind one key; the folders moved or sorted into lately are one click away. */
export function SlotFolderDialog({ slot, current, sourceFolder, onChoose, onClose, title }: Props) {
  const t = useT()
  const recent = useMemo(recentDestinations, [])
  const key = slot.toUpperCase()

  const choose = async (path: string) => {
    const ok = await onChoose(path)
    if (ok) rememberDestination(path)
    return ok
  }

  return (
    <FolderChooser
      title={title ?? t('sort.slot.chooseTitle', { key })}
      confirmLabel={t('sort.slot.use')}
      start={current ?? recent[0] ?? sourceFolder}
      shortcuts={[
        { heading: t('sort.slot.recent'), paths: recent, testId: 'folder-recent' },
        { heading: t('sort.slot.source'), paths: sourceFolder ? [sourceFolder] : [] },
      ]}
      onChoose={choose}
      onClose={onClose}
      testId="sort-folder-picker"
    />
  )
}
