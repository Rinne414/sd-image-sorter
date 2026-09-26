import { useEffect, useState } from 'react'
import { thumbnailUrl } from '../../../api/client'
import { useT } from '../../../i18n'
import { fileSize, generatorName } from '../../../lib/format'
import { parentFolder, tailOfPath } from '../../../lib/paths'
import { Icon } from '../../../ui/Icon'
import { EdgeCodes } from '../../card/sections/FilmEdge'
import { copyAndSay, openImageFolder } from '../../library/fileActions'
import { useHandoff, takeHandoff } from '../handoff'
import { DropOverlay, IntakeButtons, IntakeZone } from '../intake/Intake'
import { useIntake } from '../intake/useIntake'
import { useTT } from '../toolText'
import type { EditorSource } from './MetadataEditor'
import styles from './Reader.module.css'
import { ReaderInfo } from './ReaderInfo'
import type { ReaderView } from './readerAdapter'
import { clearReader, openLibraryImage, openUpload, useReader, useReaderData, type ReaderData, type ReaderSource } from './readerStore'

/** Images sent here from the library ("送到工具 ▸ 读图"): the last one sent is read. */
function useLibraryHandoff(): void {
  const pending = useHandoff((s) => s.pending)
  useEffect(() => {
    if (pending?.tool !== 'reader') return
    const ids = takeHandoff('reader')
    const last = ids?.at(-1)
    if (last !== undefined) openLibraryImage(last)
  }, [pending])
}

function Picture({ source }: { source: ReaderSource }) {
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
function FileLine({ source, data }: { source: ReaderSource; data: ReaderData }) {
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

function Stage({ source, data }: { source: ReaderSource; data: ReaderData }) {
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
        <IntakeButtons onFile={openUpload} />
        <button type="button" className="btn btn-ghost" onClick={clearReader} data-testid="reader-clear">
          {r('reader.clear')}
        </button>
      </div>
    </section>
  )
}

function editorSource(source: ReaderSource, data: ReaderData): EditorSource | null {
  if (source.kind === 'library') {
    const image = data.detail?.image
    return image ? { sourcePath: image.path, name: image.filename, library: { id: image.id, path: image.path } } : null
  }
  const kept = data.parse?.source_temp_path
  return kept ? { sourcePath: kept, name: source.file.name, library: null } : null
}

const sourceKey = (s: ReaderSource) => (s.kind === 'library' ? `lib-${s.id}` : `up-${s.seq}`)

function Info({ source, data, view }: { source: ReaderSource; data: ReaderData; view: ReaderView | null }) {
  const r = useTT()
  if (data.error) {
    return (
      <p className={styles.problem} role="alert" data-testid="reader-error">
        {r('reader.readFailed', { reason: data.error.message })}
      </p>
    )
  }
  if (!view) return <p className={styles.muted}>{r('reader.reading')}</p>
  return (
    <ReaderInfo
      key={sourceKey(source)}
      view={view}
      detail={data.detail}
      pixels={source.kind === 'upload' ? { src: source.url, key: String(source.seq) } : null}
      pasted={source.kind === 'upload' && source.origin === 'paste'}
      editor={editorSource(source, data)}
    />
  )
}

/** 读图: one image's full generation details, from a file brought in or the library. */
export function ReaderPage() {
  const source = useReader((s) => s.source)
  const data = useReaderData(source)
  const over = useIntake('reader', openUpload)
  useLibraryHandoff()

  return (
    <div className={styles.page} data-testid="reader-page" data-has-image={source ? true : undefined}>
      {source ? (
        <>
          <Stage source={source} data={data} />
          <div className={styles.info} data-testid="reader-info">
            <Info source={source} data={data} view={data.view} />
          </div>
        </>
      ) : (
        <IntakeZone onFile={openUpload} lead="reader.lead" hint="reader.hint" />
      )}
      {over && <DropOverlay label="reader.dropHere" />}
    </div>
  )
}
