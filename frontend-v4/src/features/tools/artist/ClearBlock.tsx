import { useRef, useState } from 'react'
import { ApiError } from '../../../api/client'
import { useT } from '../../../i18n'
import { Dialog } from '../../../ui/Dialog'
import { useToasts } from '../../../ui/toasts'
import { clearResults, useArtistStats } from './artistApi'
import styles from './Artist.module.css'
import { useAT } from './artistText'
import { selectArtist } from './artistView'

// At the bottom of the left column, apart from everything used often:
// clearing every style result, after a question with Cancel focused.

function ConfirmClear({ n, onClose }: { n: number; onClose: () => void }) {
  const t = useAT()
  const tm = useT()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      await clearResults()
      selectArtist(null)
      useToasts.getState().push(t('artist.clear.done'))
    } catch (error) {
      const busyRun = error instanceof ApiError && error.status === 409
      useToasts.getState().push(busyRun ? t('artist.clear.busy') : t('artist.clear.failed', { reason: (error as Error).message }), 'error')
    }
    onClose()
  }
  const footer = (
    <>
      <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onClose}>
        {tm('common.cancel')}
      </button>
      <button type="button" className="btn btn-danger" onClick={() => void go()} disabled={busy} data-testid="artist-clear-yes">
        {t('artist.clear.go')}
      </button>
    </>
  )
  return (
    <Dialog title={t('artist.clear.title')} onClose={onClose} footer={footer} testId="artist-clear-dialog" initialFocus={cancelRef}>
      <p className={styles.dialogBody}>{t('artist.clear.confirm', { n })}</p>
    </Dialog>
  )
}

export function ClearBlock({ locked }: { locked: boolean }) {
  const t = useAT()
  const n = useArtistStats().data?.identified_images ?? 0
  const [asking, setAsking] = useState(false)
  return (
    <section className={styles.danger} data-testid="artist-clear">
      <h3 className={styles.dangerTitle}>{t('artist.clear.title')}</h3>
      <p className={styles.hint}>{locked ? t('artist.clear.busy') : t('artist.clear.lead')}</p>
      <div className={styles.runRow}>
        <button type="button" className="btn btn-danger" onClick={() => setAsking(true)} disabled={locked} data-testid="artist-clear-button">
          {t('artist.clear.button')}
        </button>
      </div>
      {asking && <ConfirmClear n={n} onClose={() => setAsking(false)} />}
    </section>
  )
}
