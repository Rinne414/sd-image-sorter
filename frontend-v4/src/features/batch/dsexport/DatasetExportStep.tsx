import { useEffect } from 'react'
import type { Batch } from '../../../api/types'
import { useT } from '../../../i18n'
import { captionHolder } from '../edit/useCaptionSession'
import pix from '../ExportStep.module.css'
import { StepBar } from '../StepBar'
import { useBatchEntries } from '../useBatchEntries'
import { DatasetExportDone } from './DatasetExportDone'
import { DatasetPreflight } from './DatasetPreflight'
import { clearDsRun, resumeDsRun, useDsRuns } from './exportRun'
import { splitEntries } from './plan'
import { FilesFields } from './FilesFields'
import { ProcessingFields } from './ProcessingFields'
import { TrainingFields } from './TrainingFields'
import { useExportOptions } from './useExportOptions'

interface Props {
  batch: Batch
  onGo: (step: string) => void
}

/**
 * A dataset batch's export: one form (kohya by default, Anima, a plain
 * folder, or captions beside the originals) and one button that checks the
 * set and, when nothing stops it, exports it as one job.
 */
export function DatasetExportStep({ batch, onGo }: Props) {
  const t = useT()
  const o = useExportOptions(batch)
  const { entries, remove } = useBatchEntries(batch)
  const run = useDsRuns((st) => st.runs[batch.id])
  const refused = useDsRuns((st) => st.leftOut[batch.id])

  useEffect(() => {
    // Only when another batch opens: a resumed run keeps the batch it started with.
    void resumeDsRun(batch)
  }, [batch.id])

  const openInEditor = (key: string) => {
    const holder = captionHolder(batch.id)
    holder.mode = 'one'
    holder.current = key
    onGo('edit')
  }

  if (run?.state === 'done') return <DatasetExportDone result={run.result} warnings={run.warnings} entries={entries} onAgain={() => clearDsRun(batch.id)} />
  const s = o.settings
  if (!s) return <section className={pix.result}>{o.loadError ? t('dataset.loadError', { reason: o.loadError }) : t('grid.loading')}</section>
  const { send } = splitEntries(entries, new Set(refused ?? []))
  const folderImages = send.filter((e) => e.imageId === null).length
  const busy = run?.state === 'running'

  return (
    <section className={pix.step} data-testid="ds-export-step">
      <StepBar count={t('batch.pick.count', { n: entries.length })} hint={t('dataset.export.hint')} />
      <div className={pix.body}>
        <div className={pix.formScroll}>
          <fieldset className={pix.form} disabled={busy} data-testid="ds-export-form">
            <FilesFields o={o} s={s} firstName={send[0]?.filename ?? null} />
            <TrainingFields o={o} s={s} images={send.length} />
            <ProcessingFields o={o} s={s} folderImages={folderImages} />
          </fieldset>
        </div>
        <DatasetPreflight batch={batch} o={o} s={s} entries={entries} remove={remove} onOpen={openInEditor} />
      </div>
    </section>
  )
}
