import { useState } from 'react'
import type { Batch } from '../../api/types'
import { useT } from '../../i18n'
import { useJobs } from '../jobs/jobs'
import { vlmCalls, type TagScope, type TagStepOptions } from './datasetTag'
import { replaceEditedCaptions, useTagRuns } from './datasetTagApi'
import type { Entry } from './entries'
import { MergeField, type DescriberService } from './TagOptions'
import styles from './TagStep.module.css'

interface ScopeProps {
  o: TagStepOptions
  set: (o: TagStepOptions) => void
  scope: TagScope
  vlm: DescriberService | undefined
  busy: boolean
  running: boolean
  onStart: () => void
}

/** What the run will take, said before it starts: counts, re-tagging, paid calls, then the start button. */
export function ScopeBox({ o, set, scope, vlm, busy, running, onStart }: ScopeProps) {
  const t = useT()
  const sent = scope.ids.length + scope.paths.length
  const calls = vlmCalls(scope, o.describer)
  const done = scope.tagged + scope.folderDone
  // The tagger off and no describer: the run would do nothing.
  const idle = !o.tagger && o.describer === 'off'
  const startKey = o.tagger ? 'dataset.tag.start' : 'dataset.tag.startDescribe'
  return (
    <section className={styles.block} aria-labelledby="tag-scope" data-testid="tag-scope">
      <h3 id="tag-scope" className={styles.blockTitle}>
        {t('dataset.tag.scope')}
      </h3>
      <ul className={styles.counts}>
        {scope.untagged + scope.tagged > 0 && <li data-testid="scope-library">{t('dataset.tag.library', { untagged: scope.untagged, tagged: scope.tagged })}</li>}
        {scope.folderNew + scope.folderDone > 0 && <li data-testid="scope-folder">{t('dataset.tag.folder', { fresh: scope.folderNew, done: scope.folderDone })}</li>}
        {scope.missing > 0 && <li className={styles.warn}>{t('dataset.tag.missing', { n: scope.missing })}</li>}
      </ul>
      {done > 0 && (
        <label className={styles.check}>
          <input type="checkbox" checked={o.retagExisting} onChange={(e) => set({ ...o, retagExisting: e.target.checked })} data-testid="tag-retag" />
          {t(o.tagger ? 'dataset.tag.retag' : 'dataset.tag.redescribe', { n: done })}
        </label>
      )}
      <MergeField value={o.mergeStrategy} set={(mergeStrategy) => set({ ...o, mergeStrategy })} tagsReplaced={o.tagger} />
      {scope.userEdited.length > 0 && <p className={styles.hint}>{t('dataset.tag.edited', { n: scope.userEdited.length })}</p>}
      <p className={styles.total} data-testid="tag-total">
        {sent > 0 ? t('dataset.tag.total', { n: sent }) : t('dataset.tag.nothing')}
      </p>
      {o.describer === 'vlm' && sent > 0 && (
        <p className={vlm?.local ? styles.hint : styles.calls} data-testid="tag-vlm-calls">
          {t(vlm?.local ? 'dataset.tag.callsLocal' : 'dataset.tag.callsPaid', { n: calls, name: vlm?.label ?? '' })}
        </p>
      )}
      {idle && (
        <p className={styles.warn} role="status" data-testid="tag-idle">
          {t('dataset.tag.pickOne')}
        </p>
      )}
      <div className={styles.actions}>
        <button type="button" className="btn btn-primary" disabled={busy || sent === 0 || idle} onClick={onStart} data-testid="tag-start">
          {running ? t('dataset.tag.running') : t(startKey, { n: sent })}
        </button>
        {running && (
          <button type="button" className="btn btn-ghost" onClick={() => useJobs.getState().setDrawerOpen(true)}>
            {t('dataset.tag.showProgress')}
          </button>
        )}
      </div>
    </section>
  )
}

/** What a finished run changed: Library tags, folder captions, or both. */
function doneText(t: ReturnType<typeof useT>, entries: readonly Entry[], ran: ReadonlySet<string>, written: number, described: boolean): string {
  const sent = entries.filter((e) => ran.has(e.key))
  const library = sent.some((e) => e.imageId !== null)
  const folder = sent.some((e) => e.imageId === null)
  if (library && folder) return t(described ? 'dataset.tag.doneDescribed' : 'dataset.tag.done', { n: written })
  if (folder) return t('dataset.tag.doneFolder', { n: written })
  return t(described ? 'dataset.tag.doneLibraryDescribed' : 'dataset.tag.doneLibrary')
}

interface ReportProps {
  batch: Batch
  entries: readonly Entry[]
  scope: TagScope
  model: string
  running: boolean
}

/** The last run of this batch: what was written, and the user's edited captions it left alone. */
export function RunReport({ batch, entries, scope, model, running }: ReportProps) {
  const t = useT()
  const run = useTagRuns((s) => s.runs[batch.id])
  const [replacing, setReplacing] = useState(false)
  if (!run) return null
  const ran = new Set(run.ranKeys)
  const edited = scope.userEdited.filter((key) => ran.has(key))
  const state = run.writing ? t('dataset.tag.writing') : run.finished ? doneText(t, entries, ran, run.written, run.describeOnly) : running ? t('dataset.tag.inProgress') : t('dataset.tag.ended')

  const replace = async () => {
    setReplacing(true)
    await replaceEditedCaptions(batch, entries, edited, model)
    setReplacing(false)
  }

  return (
    <section className={styles.block} aria-labelledby="tag-report" data-testid="tag-report">
      <h3 id="tag-report" className={styles.blockTitle}>
        {t('dataset.tag.lastRun')}
      </h3>
      <p className={styles.note} aria-live="polite" data-testid="tag-report-state">
        {state}
      </p>
      {run.failed > 0 && <p className={styles.warn}>{t('dataset.tag.writeFailed', { n: run.failed })}</p>}
      {run.finished && edited.length > 0 && (
        <div className={styles.kept} data-testid="tag-kept">
          <p className={styles.note}>{t('dataset.tag.kept', { n: edited.length })}</p>
          <button type="button" className="btn" disabled={replacing} onClick={() => void replace()} data-testid="tag-replace">
            {t('dataset.tag.replace', { n: edited.length })}
          </button>
        </div>
      )}
    </section>
  )
}
