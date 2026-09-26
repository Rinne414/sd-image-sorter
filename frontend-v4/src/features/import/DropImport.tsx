import { useEffect, useRef, useState } from 'react'
import { api, unwrap } from '../../api/client'
import { queryClient } from '../../api/queryClient'
import { useLang, useT } from '../../i18n'
import { useApp } from '../../state/store'
import { Dialog } from '../../ui/Dialog'
import { fileDropsClaimed } from '../../ui/dropClaim'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'
import { useSelectionDialog } from '../selection/dialogs'
import styles from './DropImport.module.css'

const IMAGE = /\.(png|jpe?g|webp|bmp|gif)$/i
/** Files read from a dropped folder to recognise where it lives. */
const SAMPLE_FILES = 5

// A view that takes file drops itself (a dataset batch) has claimed them: stand aside.
const hasFiles = (e: DragEvent) => !fileDropsClaimed() && !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')

/** Over an element that takes file drops itself (data-own-drop, e.g. search by image). */
const inOwnZone = (e: DragEvent) => e.target instanceof Element && e.target.closest('[data-own-drop]') !== null

function readSample(dir: FileSystemDirectoryEntry): Promise<{ name: string; size: number }[]> {
  return new Promise((resolve) => {
    dir.createReader().readEntries(
      (entries) => {
        const files = entries.filter((e): e is FileSystemFileEntry => e.isFile && IMAGE.test(e.name)).slice(0, SAMPLE_FILES)
        Promise.all(files.map((f) => new Promise<{ name: string; size: number }>((ok) => f.file((file) => ok({ name: file.name, size: file.size }), () => ok({ name: f.name, size: 0 })))))
          .then(resolve)
          .catch(() => resolve([]))
      },
      () => resolve([]),
    )
  })
}

/** A dropped folder: find where it is on disk and open the import dialog there. */
async function openFolder(dir: FileSystemDirectoryEntry): Promise<void> {
  const files = await readSample(dir)
  let folder: string | null = null
  try {
    const res = unwrap<{ folder_path?: string }>(await api.POST('/api/resolve-drop', { body: { folder_name: dir.name, files } }))
    folder = res.folder_path ?? null
  } catch {
    folder = null
  }
  if (!folder) useToasts.getState().push(tr('drop.folderUnknown', { name: dir.name }), 'error')
  useSelectionDialog.getState().showFor('import', null, 1, folder ?? undefined)
}

/** Copies dropped image files into the app's import folder, only after the user agrees. */
export function DropImport() {
  const t = useT()
  const lang = useLang((s) => s.lang)
  const [over, setOver] = useState(false)
  const [inZone, setInZone] = useState(false)
  const [files, setFiles] = useState<File[] | null>(null)
  const [busy, setBusy] = useState(false)
  const depth = useRef(0)

  useEffect(() => {
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current += 1
      setOver(true)
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setOver(false)
    }
    const overFn = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setInZone(inOwnZone(e))
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e) || !e.dataTransfer) return
      depth.current = 0
      setOver(false)
      setInZone(false)
      // A zone that takes the drop itself has handled it: not an import.
      if (e.defaultPrevented || inOwnZone(e)) return
      e.preventDefault()
      const items = [...e.dataTransfer.items]
      const dirs = items.map((i) => i.webkitGetAsEntry?.()).filter((en): en is FileSystemDirectoryEntry => !!en && en.isDirectory)
      if (dirs[0]) {
        void openFolder(dirs[0])
        return
      }
      const images = [...e.dataTransfer.files].filter((f) => IMAGE.test(f.name))
      if (images.length) setFiles(images)
      else useToasts.getState().push(tr('drop.nothing'), 'error')
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', overFn)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', overFn)
      window.removeEventListener('drop', drop)
    }
  }, [])

  const copyIn = async () => {
    if (!files) return
    setBusy(true)
    const form = new FormData()
    for (const f of files) form.append('files', f, f.name)
    try {
      const res = await fetch('/api/import-files', {
        method: 'POST',
        body: form,
        headers: { 'X-SD-Library-Id': useApp.getState().libraryId },
      })
      if (!res.ok) throw new Error(res.statusText)
      const body = (await res.json()) as { imported?: number; errors?: number }
      for (const key of ['images', 'generators', 'folders', 'libraries', 'image-count']) void queryClient.invalidateQueries({ queryKey: [key] })
      useToasts.getState().push(
        body.errors ? t('drop.copiedWithErrors', { n: body.imported ?? 0, errors: body.errors }) : t('drop.copied', { n: body.imported ?? 0 }),
        body.errors ? 'error' : 'info',
      )
      setFiles(null)
    } catch (error) {
      useToasts.getState().push(t('error.generic', { reason: (error as Error).message }), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {over && !inZone && (
        <div className={styles.overlay} aria-hidden data-testid="drop-overlay">
          <p className={styles.text}>{t('drop.hint')}</p>
        </div>
      )}
      {files && (
        <Dialog
          title={t('drop.title', { n: files.length })}
          onClose={() => setFiles(null)}
          testId="drop-dialog"
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setFiles(null)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void copyIn()} disabled={busy}>
                {t('drop.copyIn', { n: files.length })}
              </button>
            </>
          }
        >
          <p className={styles.body}>{t('drop.body')}</p>
          <p className={styles.names}>{files.slice(0, 3).map((f) => f.name).join(lang === 'zh-CN' ? '、' : ', ') + (files.length > 3 ? ' …' : '')}</p>
        </Dialog>
      )}
    </>
  )
}
