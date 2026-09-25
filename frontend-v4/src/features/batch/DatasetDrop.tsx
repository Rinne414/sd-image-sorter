import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { useApp } from '../../state/store'
import { claimFileDrops } from '../../ui/dropClaim'
import { layerCount } from '../../ui/layers'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'
import { takeDrop, useDatasetImport } from './datasetImport'
import styles from './PickStep.module.css'

const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')

/**
 * While a dataset batch's pick step is shown, files dragged in from outside
 * are for it (the Library import stands aside): images, ZIP, RAR or a folder.
 * Returns whether files are being dragged over the window.
 */
export function useDatasetDrop(batchId: number, enabled: boolean): boolean {
  const [over, setOver] = useState(false)
  const depth = useRef(0)

  useEffect(() => {
    if (!enabled) return
    const release = claimFileDrops()
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
      if (hasFiles(e)) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e) || !e.dataTransfer) return
      e.preventDefault()
      depth.current = 0
      setOver(false)
      // A dialog on top (or another page) is not a drop on the batch.
      if (layerCount() > 0 || useApp.getState().page !== 'batch') return
      if (useDatasetImport.getState().batchId !== null) {
        useToasts.getState().push(tr('dataset.importBusy'), 'error')
        return
      }
      void takeDrop(batchId, e.dataTransfer)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', overFn)
    window.addEventListener('drop', drop)
    return () => {
      release()
      depth.current = 0
      setOver(false)
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', overFn)
      window.removeEventListener('drop', drop)
    }
  }, [batchId, enabled])

  return over
}

export function DropOverlay() {
  const t = useT()
  return (
    <div className={styles.dropOverlay} aria-hidden data-testid="dataset-drop-overlay">
      <p className={styles.dropText}>{t('dataset.dropHint')}</p>
    </div>
  )
}
