import { useT, type MessageKey } from '../../../i18n'
import { useToasts } from '../../../ui/toasts'
import { openFolderPath } from '../../library/fileActions'
import { isFinished } from '../../jobs/progress'
import type { Job } from '../../jobs/jobs'
import type { MediaFile, MediaFileStatus } from '../../jobs/mediaCensorJob'
import { revealMedia } from './mediaApi'
import styles from './MediaCensorResult.module.css'

// The Jobs drawer's part for a GIF / video censor job: each file's state, a way
// to see each finished file in its folder, and the output folder itself.
// Failed files are listed by the drawer's own failure list.

const STATUS_TEXT: Record<Exclude<MediaFileStatus, 'error'>, MessageKey> = {
  queued: 'mediacensor.result.queued',
  running: 'mediacensor.result.running',
  done: 'mediacensor.result.done',
  skipped: 'mediacensor.result.skipped',
}

export function MediaCensorResult({ job }: { job: Job }) {
  const t = useT()
  const media = job.progress.media
  if (job.kind !== 'mediacensor' || !media) return null
  const finished = isFinished(job.progress.status)
  const listed = media.files.map((file, index) => ({ file, index })).filter(({ file }) => file.status !== 'error')

  const show = async (index: number) => {
    try {
      await revealMedia(media.jobId, index)
    } catch (error) {
      useToasts.getState().push(t('mediacensor.result.showFailed', { reason: (error as Error).message }), 'error')
    }
  }
  const text = (file: MediaFile) => {
    if (file.status === 'done') return file.censoredFrames > 0 ? t('mediacensor.result.done', { n: file.censoredFrames }) : t('mediacensor.result.doneNone')
    return t(STATUS_TEXT[file.status as Exclude<MediaFileStatus, 'error'>])
  }

  return (
    <div className={styles.wrap} data-testid="mediacensor-result">
      {listed.length > 0 && (
        <ul className={styles.list}>
          {listed.map(({ file, index }) => (
            <li key={`${index}-${file.name}`} className={styles.row} data-status={file.status} data-testid="mediacensor-file">
              <span className={`${styles.name} mono`} title={file.name}>
                {file.name}
              </span>
              <span className={styles.state}>{text(file)}</span>
              {file.status === 'done' && file.output && (
                <button type="button" className="btn btn-ghost" onClick={() => void show(index)} data-testid="mediacensor-reveal">
                  {t('mediacensor.result.show')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {finished && media.folder && job.progress.succeeded > 0 && (
        <button type="button" className="btn" onClick={() => void openFolderPath(media.folder)} data-testid="mediacensor-open-folder">
          {t('mediacensor.result.openFolder')}
        </button>
      )}
    </div>
  )
}
