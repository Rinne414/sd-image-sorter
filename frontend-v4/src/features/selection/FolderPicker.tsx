import { useMemo } from 'react'
import { findLoadedImage } from '../../api/loaded'
import { useT } from '../../i18n'
import { parentFolder } from '../../lib/paths'
import { FolderChooser } from '../../ui/FolderChooser'
import { startFileJob } from '../jobs/fileJobs'
import { recentDestinations, rememberDestination } from './dialogs'

interface Props {
  operation: 'move' | 'copy'
  ids: number[]
  onClose: () => void
}

/** Where picked images go: opens where the first pick lives, offers the recent destinations. */
export function FolderPicker({ operation, ids, onClose }: Props) {
  const t = useT()
  const recent = useMemo(recentDestinations, [])
  const source = useMemo(() => {
    const first = ids[0]
    const img = first === undefined ? null : findLoadedImage(first)
    return img ? parentFolder(img.path) : null
  }, [ids])

  const choose = async (target: string) => {
    const ok = await startFileJob(operation, ids, target)
    if (ok) rememberDestination(target)
    return ok
  }

  return (
    <FolderChooser
      title={t(operation === 'move' ? 'picker.titleMove' : 'picker.titleCopy', { n: ids.length })}
      confirmLabel={t(operation === 'move' ? 'picker.confirmMove' : 'picker.confirmCopy', { n: ids.length })}
      start={source ?? recent[0] ?? null}
      shortcuts={[
        { heading: t('picker.source'), paths: source ? [source] : [] },
        { heading: t('picker.recent'), paths: recent, testId: 'folder-recent' },
      ]}
      onChoose={choose}
      onClose={onClose}
    />
  )
}
