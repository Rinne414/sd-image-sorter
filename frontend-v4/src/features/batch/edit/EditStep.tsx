import { useEffect, useMemo, useState } from 'react'
import type { Batch, BatchProjectView } from '../../../api/types'
import { useT } from '../../../i18n'
import { useBatchProject } from '../datasetApi'
import { formFromSettings, readBatchDataset, type DatasetForm } from '../datasetSettings'
import { useProjectHeads } from '../datasetTagApi'
import type { Entry } from '../entries'
import { stepLabel } from '../labels'
import { setSettingsPanel } from '../settingsPanel'
import { StepBar } from '../StepBar'
import { useBatchEntries } from '../useBatchEntries'
import { snapshotOf, useUneditedCaptions } from './captionApi'
import { EditorColumn } from './EditorColumn'
import styles from './EditStep.module.css'
import { ItemList } from './ItemList'
import { afterRemoval, entryMarks, filterCounts, matches, stepKey, type ListFilter } from './marks'
import { Stage } from './Stage'
import { captionHolder, useCaptionSession } from './useCaptionSession'
import { useEditKeys } from './useEditKeys'

interface Props {
  batch: Batch
  next: string | null
  onNext: (step: string) => void
}

/** The images the list shows (by filter), their marks, and the counts per filter. */
function useListing(batch: Batch, view: BatchProjectView | undefined, form: DatasetForm | null, entries: readonly Entry[], filter: ListFilter) {
  const heads = useProjectHeads(view)
  const unedited = useUneditedCaptions(batch, form, entries)
  const marks = useMemo(
    () => new Map(entries.map((e) => [e.key, entryMarks(e, heads.data?.get(e.key), unedited.data?.get(e.key), form)])),
    [entries, heads.data, unedited.data, form],
  )
  const shown = useMemo(() => entries.filter((e) => { const m = marks.get(e.key); return !m || matches(m, filter) }), [entries, marks, filter])
  const counts = useMemo(() => filterCounts([...marks.values()]), [marks])
  return { heads, marks, shown, counts }
}

/**
 * A dataset batch's edit step: the images down the left, the picture in the
 * middle, the one caption editor on the right. Every change is saved as a
 * revision of this batch's training caption; the Library's tags are never
 * touched here (the generation card edits those).
 */
export function EditStep({ batch, next, onNext }: Props) {
  const t = useT()
  const view = useBatchProject(batch).data
  const { entries, remove, loading, error } = useBatchEntries(batch)
  const form = useMemo(() => (view ? formFromSettings(view.project.settings, readBatchDataset(batch.settings)) : null), [view, batch.settings])
  const session = useCaptionSession(batch.id, entries)
  const holder = captionHolder(batch.id)
  const [filter, setFilter] = useState<ListFilter>('all')
  const [picked, setPicked] = useState<string | null>(holder.current)
  const [compareKey, setCompareKey] = useState<string | null>(null)
  const { heads, marks, shown, counts } = useListing(batch, view, form, entries, filter)
  const current = entries.find((e) => e.key === picked) ?? shown[0] ?? entries[0] ?? null
  const keys = shown.map((e) => e.key)

  useEffect(() => {
    holder.current = current?.key ?? null
  }, [holder, current])

  const pick = (key: string | null) => {
    if (current) void session.flush(current.key)
    setPicked(key)
  }
  const go = (step: 1 | -1) => pick(stepKey(keys, current?.key ?? null, step))
  useEditKeys({
    go,
    drop: () => {
      if (!current) return
      void session.flush(current.key)
      setPicked(afterRemoval(keys, current.key))
      remove([current.key])
    },
    undo: () => current && session.undo(current.key),
  })

  const vocabulary = useMemo(() => {
    const seen = new Set<string>()
    for (const info of heads.data?.values() ?? []) for (const tag of (info.content?.booru_caption ?? '').split(',')) if (tag.trim()) seen.add(tag.trim())
    return [...seen]
  }, [heads.data])

  const at = current ? keys.indexOf(current.key) : -1
  const body =
    loading || !view || !form ? (
      <p className={styles.empty}>{error ? t('dataset.loadError', { reason: error }) : t('grid.loading')}</p>
    ) : entries.length === 0 || !current ? (
      <p className={styles.empty}>{t('dataset.preview.noImages')}</p>
    ) : (
      <div className={styles.body}>
        <ItemList
          shown={shown}
          marks={marks}
          counts={counts}
          filter={filter}
          onFilter={setFilter}
          current={current.key}
          onPick={pick}
          noTrigger={!form.trigger}
          onSettings={() => setSettingsPanel(true)}
        />
        <Stage batch={batch} view={view} form={form} entry={current} shown={shown} compareKey={compareKey} onCompare={setCompareKey} heads={heads.data} />
        <EditorColumn
          key={current.key}
          batch={batch}
          view={view}
          form={form}
          entry={current}
          head={snapshotOf(heads.data?.get(current.key))}
          headsReady={heads.data !== undefined}
          session={session}
          position={{ at: at + 1, of: keys.length }}
          onGo={go}
          vocabulary={vocabulary}
        />
      </div>
    )

  return (
    <section className={styles.step} data-testid="edit-step">
      <StepBar count={t('batch.pick.count', { n: entries.length })} hint={t('dataset.edit.hint')}>
        {next && (
          <button type="button" className="btn" onClick={() => onNext(next)} data-testid="step-next">
            {t('batch.panel.next', { step: stepLabel(next, t) })}
          </button>
        )}
      </StepBar>
      {body}
    </section>
  )
}
