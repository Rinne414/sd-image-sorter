import { useRef } from 'react'
import { useT } from '../../../i18n'
import { fileSize } from '../../../lib/format'
import { Dialog } from '../../../ui/Dialog'
import { useJobs } from '../../jobs/jobs'
import { isFinished } from '../../jobs/progress'
import { installUpdate } from '../restart'
import styles from './About.module.css'
import { useUpdates } from './updateStore'

/**
 * Before installing: what is downloaded, what it replaces and what it leaves
 * alone, that the app restarts and for how long, the jobs it would stop, and
 * what happens to this V4 preview (D43).
 */
export function InstallDialog({ latest, sizeBytes, onClose }: { latest: string; sizeBytes: number | null; onClose: () => void }) {
  const t = useT()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const running = useJobs((s) => s.jobs.filter((j) => !isFinished(j.progress.status)).length)
  const size = sizeBytes ? t('about.install.size', { size: fileSize(sizeBytes) }) : ''

  const go = async () => {
    onClose()
    if ((await installUpdate(latest)) === 'upToDate') void useUpdates.getState().check(false)
  }

  return (
    <Dialog
      title={t('about.install.title', { latest })}
      onClose={onClose}
      testId="install-dialog"
      initialFocus={cancelRef}
      footer={
        <>
          <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void go()} data-testid="install-go">
            {t('about.install.ok')}
          </button>
        </>
      }
    >
      <div className={styles.dialogText}>
        <p>{t('about.install.what', { latest, size })}</p>
        <p>{t('about.install.restart')}</p>
        {running > 0 && (
          <p className={styles.warn} data-testid="install-jobs">
            {t('about.install.jobs', { n: running })}
          </p>
        )}
      </div>
    </Dialog>
  )
}
