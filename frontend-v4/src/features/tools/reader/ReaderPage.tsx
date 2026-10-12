import { useEffect, useRef, useState } from 'react'
import { DropOverlay, IntakeZone } from '../intake/Intake'
import { sourceKey, useSourceHandoff } from '../intake/sourceStore'
import { useIntake } from '../intake/useIntake'
import { useTT } from '../toolText'
import type { EditorSource } from './MetadataEditor'
import styles from './Reader.module.css'
import { ReaderInfo } from './ReaderInfo'
import { Stage } from './ReaderStage'
import type { ReaderView } from './readerAdapter'
import { rememberScroll, useKeptScroll } from './readerScroll'
import { clearReader, openLibraryImage, openUpload, useReader, useReaderData, type ReaderData, type ReaderSource } from './readerStore'

function editorSource(source: ReaderSource, data: ReaderData): EditorSource | null {
  if (source.kind === 'library') {
    const image = data.detail?.image
    return image ? { sourcePath: image.path, name: image.filename, library: { id: image.id, path: image.path } } : null
  }
  const kept = data.parse?.source_temp_path
  return kept ? { sourcePath: kept, name: source.file.name, library: null } : null
}

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

interface Shown {
  source: ReaderSource
  data: ReaderData
}

/**
 * What the info column shows: this image once it is read, and meanwhile the
 * one before it (so the column keeps its length and its place, as V3.5's did).
 */
function useShownInfo(source: ReaderSource | null, data: ReaderData): { shown: Shown | null; stale: boolean } {
  const [last, setLast] = useState<Shown | null>(null)
  const ready = source !== null && (data.view !== null || data.error !== null)
  const { view, error } = data
  useEffect(() => {
    // Only a newly read image replaces the kept one (data itself is a new object every render).
    if (ready && source) setLast({ source, data })
    else if (!source) setLast(null)
  }, [ready, source, view, error])
  if (ready && source) return { shown: { source, data }, stale: false }
  return last && source ? { shown: last, stale: true } : { shown: source ? { source, data } : null, stale: false }
}

/** 读图: one image's full generation details, from a file brought in or the library. */
export function ReaderPage() {
  const source = useReader((s) => s.source)
  const data = useReaderData(source)
  const over = useIntake('reader', openUpload)
  useSourceHandoff('reader', openLibraryImage)
  const { shown, stale } = useShownInfo(source, data)
  const infoRef = useRef<HTMLDivElement>(null)
  useKeptScroll(infoRef, shown && !stale && shown.data.view ? sourceKey(shown.source) : null)

  return (
    <div className={styles.page} data-testid="reader-page" data-has-image={source ? true : undefined}>
      {source ? (
        <>
          <Stage source={source} data={data} onFile={openUpload} onClear={clearReader} />
          <div ref={infoRef} className={styles.info} data-testid="reader-info" data-stale={stale || undefined} aria-busy={stale || undefined} inert={stale} onScroll={(e) => rememberScroll(e.currentTarget)}>
            {shown && <Info source={shown.source} data={shown.data} view={shown.data.view} />}
          </div>
        </>
      ) : (
        <IntakeZone onFile={openUpload} lead="reader.lead" hint="reader.hint" />
      )}
      {over && <DropOverlay label="reader.dropHere" />}
    </div>
  )
}
