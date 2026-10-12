import { useState } from 'react'
import { thumbnailUrl } from '../../../api/client'
import { useT } from '../../../i18n'
import { fileSize, generatorName } from '../../../lib/format'
import { parentFolder, tailOfPath } from '../../../lib/paths'
import { Icon } from '../../../ui/Icon'
import { EdgeCodes } from '../../card/sections/FilmEdge'
import { copyAndSay, openImageFolder } from '../../library/fileActions'
import { IntakeButtons } from '../intake/Intake'
import type { IntakeOrigin } from '../intake/intakeFiles'
import type { ImageSource } from '../intake/sourceStore'
import { useTT } from '../toolText'
import styles from './Reader.module.css'
import type { ReaderData } from './readerStore'

// The left side of the Reader and of Reverse prompt: the image being read.

type OnFile = (file: File, origin: IntakeOrigin) => void

function Picture({ source }: { source: ImageSource }) {
  const [big, setBig] = useState<number | null>(null)
  if (source.kind === 'upload') return <img className={styles.picture} src={source.url} alt="" draggable={false} data-testid="reader-picture" />
  return (
    <>
      <img className={styles.picture} src={thumbnailUrl(source.id, 384)} alt="" draggable={false} />
      <img
        key={source.id}
        className={`${styles.picture} ${styles.pictureOver}`}
        data-ready={big === source.id || undefined}
        src={thumbnailUrl(source.id, 1024)}
        alt=""
        draggable={false}
        onLoad={() => setBig(source.id)}
        data-testid="reader-picture"
      />
    </>
  )
}

/** The file's name, size and where it lives (a library image: open its folder, copy its path). */
function FileLine({ source, data }: { source: ImageSource; data: ReaderData }) {
  const t = useT()
  const r = useTT()
  const view = data.view
  const name = source.kind === 'upload' ? source.file.name : (data.detail?.image.filename ?? '…')
  const path = data.detail?.image.path ?? null
  const dims = view?.width && view.height ? `${view.width}×${view.height}` : ''
  const facts = [dims, fileSize(view?.fileSize ?? (source.kind === 'upload' ? source.file.size : null))].filter(Boolean).join(' · ')
  return (
    <header className={styles.fileHead}>
      <span className={styles.generator} data-testid="reader-generator">
        {view ? generatorName(view.generator, t) : ''}
      </span>
      <span className={`${styles.fileName} mono`} title={path ?? name} data-testid="reader-file-name">
        {name}
      </span>
      <span className={`${styles.muted} mono`}>{facts}</span>
      {source.kind === 'library' && path && (
        <span className={styles.fileTools}>
          <span className={`${styles.muted} mono`} title={path}>
            {r('reader.inLibrary')} · {tailOfPath(parentFolder(path) ?? path, 40)}
          </span>
          <button type="button" className={styles.iconButton} onClick={() => void openImageFolder(source.id)} title={t('lib.file.openFolder')} aria-label={t('lib.file.openFolder')}>
            <Icon name="folder" size={14} />
          </button>
          <button type="button" className={styles.iconButton} onClick={() => void copyAndSay(path, { key: 'lib.file.path' })} title={t('lib.file.copyPath')} aria-label={t('lib.file.copyPath')}>
            <Icon name="copy" size={14} />
          </button>
        </span>
      )}
    </header>
  )
}

/** The picture in its film frame, with the file's line above and the ways to bring another below. */
export function Stage({ source, data, onFile, onClear }: { source: ImageSource; data: ReaderData; onFile: OnFile; onClear: () => void }) {
  const r = useTT()
  const view = data.view
  return (
    <section className={styles.stage} aria-label={r('reader.picture')}>
      <FileLine source={source} data={data} />
      <figure className={styles.frame}>
        <EdgeCodes gen={view?.gen ?? null} generator={view?.generator ?? null} part="top" />
        <div className={styles.window}>
          <Picture source={source} />
        </div>
        <EdgeCodes gen={view?.gen ?? null} generator={view?.generator ?? null} part="bottom" />
      </figure>
      {source.kind === 'upload' && source.origin === 'paste' && view?.prompt && (
        <p className={styles.note} data-testid="reader-paste-note">
          {r('reader.pastedMayMiss')}
        </p>
      )}
      <div className={styles.stageActions}>
        <IntakeButtons onFile={onFile} />
        <button type="button" className="btn btn-ghost" onClick={onClear} data-testid="reader-clear">
          {r('reader.clear')}
        </button>
      </div>
    </section>
  )
}
