import { useEffect } from 'react'
import { DropOverlay, IntakeZone } from '../intake/Intake'
import { sourceKey, useSourceHandoff, type ImageSource } from '../intake/sourceStore'
import { useIntake } from '../intake/useIntake'
import { Stage } from '../reader/ReaderStage'
import { useReaderData, type ReaderData } from '../reader/readerStore'
import { useTT } from '../toolText'
import { DraftBox } from './DraftBox'
import styles from './Reverse.module.css'
import { InferredCard, RecordedCard, type FileRecord } from './ReverseCards'
import { clearReverse, forgetRunUnless, openReverseLibraryImage, openReverseUpload, useReverseRun, useReverseSource } from './reverseStore'
import { RunPanel } from './RunPanel'

function recordOf(data: ReaderData): FileRecord | null {
  const view = data.view
  if (!view?.prompt.trim()) return null
  return { prompt: view.prompt, negative: view.negative, generator: view.generator }
}

/** The file the tagger and vision model read: the upload's kept copy, or the library file. */
function pathOf(source: ImageSource, data: ReaderData): string | null {
  if (source.kind === 'library') return data.detail?.image.path ?? null
  return data.parse?.source_temp_path ?? null
}

function Answers({ source, data }: { source: ImageSource; data: ReaderData }) {
  const t = useTT()
  const key = sourceKey(source)
  const result = useReverseRun((s) => (s.key === key ? s.result : null))
  const method = useReverseRun((s) => s.method)
  if (data.error) {
    return (
      <p className={styles.problem} role="alert" data-testid="reverse-read-error">
        {t('reader.readFailed', { reason: data.error.message })}
      </p>
    )
  }
  if (!data.view) return <p className={styles.muted}>{t('reader.reading')}</p>
  const record = recordOf(data)
  return (
    <>
      <RecordedCard record={record} />
      <RunPanel runKey={key} path={pathOf(source, data)} hasRecord={record !== null} />
      {result && <InferredCard prompt={result.prompt} method={method} hasRecord={record !== null} />}
    </>
  )
}

/** 反推提示词: the prompt a picture's file recorded first, then one worked out from its pixels. */
export function ReversePage() {
  const source = useReverseSource((s) => s.source)
  const data = useReaderData(source)
  const over = useIntake('reverse', openReverseUpload)
  useSourceHandoff('reverse', openReverseLibraryImage)
  const key = source ? sourceKey(source) : null

  // A run belongs to its image: another image drops it.
  useEffect(() => {
    if (key) forgetRunUnless(key)
  }, [key])

  return (
    <div className={styles.page} data-testid="reverse-page" data-has-image={source ? true : undefined}>
      {source ? (
        <>
          <Stage source={source} data={data} onFile={openReverseUpload} onClear={clearReverse} />
          <div className={styles.side} data-testid="reverse-side">
            <div className={styles.column}>
              <Answers source={source} data={data} />
              {/* the draft stays; TIPO's suggestions for the last image close */}
              <DraftBox key={key} imageId={source.kind === 'library' ? source.id : null} />
            </div>
          </div>
        </>
      ) : (
        <IntakeZone onFile={openReverseUpload} lead="reverse.lead" hint="reverse.hint" />
      )}
      {over && <DropOverlay label="reverse.dropHere" />}
    </div>
  )
}
