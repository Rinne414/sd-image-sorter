import { imageFileUrl } from '../../../api/client'
import type { Batch, BatchProjectView } from '../../../api/types'
import { useT } from '../../../i18n'
import { Icon } from '../../../ui/Icon'
import type { DatasetForm } from '../datasetSettings'
import type { HeadInfo } from '../datasetTag'
import { localThumbnailUrl, type Entry } from '../entries'
import { snapshotOf, useFinalCaption } from './captionApi'
import styles from './EditStep.module.css'
import { FinalPreview } from './FinalPreview'
import { stepKey } from './marks'
import { ZoomImage } from './ZoomImage'

/** Folder pictures are served scaled to this long side at most (large enough to check detail at 100%). */
const FOLDER_SIZE = 2048

/** The full picture: the Library file, or a folder image scaled by the backend. */
export function bigUrl(entry: Entry): string | null {
  if (entry.imageId !== null) return imageFileUrl(entry.imageId)
  if (entry.path !== null && entry.status !== 'missing') return localThumbnailUrl(entry.path, FOLDER_SIZE)
  return null
}

interface Props {
  batch: Batch
  view: BatchProjectView
  form: DatasetForm
  entry: Entry
  shown: readonly Entry[]
  compareKey: string | null
  onCompare: (key: string | null) => void
  heads: ReadonlyMap<string, HeadInfo> | undefined
}

/** The picture being captioned; beside it, on request, another image of the batch with its final caption. */
export function Stage({ batch, view, form, entry, shown, compareKey, onCompare, heads }: Props) {
  const t = useT()
  const others = shown.filter((e) => e.key !== entry.key)
  const other = others.find((e) => e.key === compareKey) ?? null
  const keys = others.map((e) => e.key)
  // Compare with the image after this one (or before it, at the end).
  const at = shown.findIndex((e) => e.key === entry.key)
  const start = () => onCompare((shown[at + 1] ?? shown[at - 1] ?? others[0])?.key ?? null)

  return (
    <div className={styles.stage} data-compare={other ? true : undefined}>
      <div className={styles.stageBar}>
        <span className={`${styles.stageName} mono`} title={entry.path ?? entry.filename}>
          {entry.filename}
        </span>
        <span className={styles.gap} />
        <button
          type="button"
          className="btn btn-ghost"
          aria-pressed={!!other}
          disabled={!other && others.length === 0}
          onClick={() => (other ? onCompare(null) : start())}
          data-testid="edit-compare"
        >
          {t('dataset.edit.compare')}
        </button>
      </div>
      <div className={styles.panes}>
        <ZoomImage src={bigUrl(entry)} missing={t('dataset.fileGone')} testId="edit-image" />
        {other && (
          <ComparePane
            batch={batch}
            view={view}
            form={form}
            entry={other}
            head={heads?.get(other.key)}
            headsKnown={heads !== undefined}
            onStep={(step) => onCompare(stepKey(keys, other.key, step))}
            onClose={() => onCompare(null)}
          />
        )}
      </div>
    </div>
  )
}

interface PaneProps {
  batch: Batch
  view: BatchProjectView
  form: DatasetForm
  entry: Entry
  head: HeadInfo | undefined
  headsKnown: boolean
  onStep: (step: 1 | -1) => void
  onClose: () => void
}

function ComparePane({ batch, view, form, entry, head, headsKnown, onStep, onClose }: PaneProps) {
  const t = useT()
  const snapshot = snapshotOf(head)
  const final = useFinalCaption(batch, view, form, entry, snapshot, headsKnown)
  return (
    <section className={styles.compare} aria-label={t('dataset.edit.compareWith', { name: entry.filename })} data-testid="edit-compare-pane">
      <header className={styles.compareHead}>
        <button type="button" className="btn btn-ghost btn-icon" onClick={() => onStep(-1)} aria-label={t('dataset.edit.prev')} title={t('dataset.edit.prev')}>
          <Icon name="left" size={14} />
        </button>
        <span className={`${styles.stageName} mono`} title={entry.filename} data-testid="edit-compare-name">
          {entry.filename}
        </span>
        <button type="button" className="btn btn-ghost btn-icon" onClick={() => onStep(1)} aria-label={t('dataset.edit.next')} title={t('dataset.edit.next')}>
          <Icon name="right" size={14} />
        </button>
        <span className={styles.gap} />
        <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label={t('dataset.edit.compareClose')} title={t('dataset.edit.compareClose')}>
          <Icon name="close" size={12} />
        </button>
      </header>
      <ZoomImage src={bigUrl(entry)} missing={t('dataset.fileGone')} />
      <div className={styles.compareCaption}>
        <FinalPreview
          form={form}
          final={final.data}
          failed={final.isError ? final.error.message : null}
          pending={false}
          fromTemplate={!snapshot.content}
          testId="edit-compare-final"
        />
      </div>
    </section>
  )
}
