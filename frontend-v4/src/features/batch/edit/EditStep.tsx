import { useEffect, useMemo, useState } from 'react'
import type { Batch, BatchProjectView } from '../../../api/types'
import { useT } from '../../../i18n'
import { useBatchProject } from '../datasetApi'
import { formFromSettings, readBatchDataset, type DatasetForm } from '../datasetSettings'
import type { HeadInfo } from '../datasetTag'
import { useProjectHeads } from '../datasetTagApi'
import type { Entry } from '../entries'
import { stepLabel } from '../labels'
import { setSettingsPanel } from '../settingsPanel'
import { StepBar } from '../StepBar'
import { useBatchEntries } from '../useBatchEntries'
import { BulkView } from './BulkView'
import { snapshotOf, useUneditedCaptions } from './captionApi'
import type { CaptionSession } from './captionSession'
import { EditorColumn } from './EditorColumn'
import styles from './EditStep.module.css'
import { ItemList, type Picking } from './ItemList'
import { afterRemoval, entryMarks, filterCounts, matches, stepKey, toggleSelection, type ListFilter } from './marks'
import { Stage } from './Stage'
import { captionHolder, useCaptionSession } from './useCaptionSession'
import { useEditKeys } from './useEditKeys'

interface Props {
  batch: Batch
  next: string | null
  onNext: (step: string) => void
}

type Mode = 'one' | 'bulk'

/** The images the list shows (by filter), their marks, and the counts per filter. */
function useListing(batch: Batch, view: BatchProjectView | undefined, form: DatasetForm | null, entries: readonly Entry[], filter: ListFilter) {
  const heads = useProjectHeads(view)
  const unedited = useUneditedCaptions(batch, form, entries)
  const marks = useMemo(
    () => new Map(entries.map((e) => [e.key, entryMarks(e, heads.data?.get(e.key), unedited.data?.get(e.key), form)])),
    [entries, heads.data, unedited.data, form],
  )
  const shown = useMemo(
    () =>
      entries.filter((e) => {
        const m = marks.get(e.key)
        return !m || matches(m, filter)
      }),
    [entries, marks, filter],
  )
  const counts = useMemo(() => filterCounts([...marks.values()]), [marks])
  return { heads, marks, shown, counts }
}

/** Images picked for a bulk change, in the order they were picked; Shift+click takes a range of the list. */
function usePicking(shown: readonly Entry[]): Picking & { set: (keys: Iterable<string>) => void } {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const keys = shown.map((e) => e.key)
  const order = useMemo(() => new Map([...selected].map((key, i) => [key, i + 1])), [selected])
  return {
    selected,
    order,
    toggle: (key, range) => {
      setSelected(toggleSelection(keys, selected, anchor, key, range))
      setAnchor(key)
    },
    all: () => setSelected(new Set([...selected, ...keys])),
    clear: () => setSelected(new Set()),
    set: (next) => setSelected(new Set(next)),
  }
}

function ModeSwitch({ mode, onMode }: { mode: Mode; onMode: (mode: Mode) => void }) {
  const t = useT()
  return (
    <div className={styles.modes} role="group" aria-label={t('dataset.bulk.modeLabel')}>
      <button type="button" className={styles.mode} aria-pressed={mode === 'one'} onClick={() => onMode('one')} data-testid="edit-mode-one">
        {t('dataset.bulk.modeOne')}
      </button>
      <button type="button" className={styles.mode} aria-pressed={mode === 'bulk'} onClick={() => onMode('bulk')} data-testid="edit-mode-bulk">
        {t('dataset.bulk.modeMany')}
      </button>
    </div>
  )
}

interface OneProps {
  batch: Batch
  view: BatchProjectView
  form: DatasetForm
  entries: readonly Entry[]
  shown: readonly Entry[]
  current: Entry
  heads: ReadonlyMap<string, HeadInfo> | undefined
  session: CaptionSession
  onGo: (step: 1 | -1) => void
}

/** One caption at a time: the picture in the middle (and one to compare), the editor on the right. */
function OneView({ batch, view, form, shown, current, heads, session, onGo }: OneProps) {
  const [compareKey, setCompareKey] = useState<string | null>(null)
  const keys = shown.map((e) => e.key)
  const at = keys.indexOf(current.key)
  const vocabulary = useMemo(() => {
    const seen = new Set<string>()
    for (const info of heads?.values() ?? []) for (const tag of (info.content?.booru_caption ?? '').split(',')) if (tag.trim()) seen.add(tag.trim())
    return [...seen]
  }, [heads])
  return (
    <>
      <Stage batch={batch} view={view} form={form} entry={current} shown={shown} compareKey={compareKey} onCompare={setCompareKey} heads={heads} />
      <EditorColumn
        key={current.key}
        batch={batch}
        view={view}
        form={form}
        entry={current}
        head={snapshotOf(heads?.get(current.key))}
        headsReady={heads !== undefined}
        session={session}
        position={{ at: at + 1, of: keys.length }}
        onGo={onGo}
        vocabulary={vocabulary}
      />
    </>
  )
}

/**
 * A dataset batch's edit step: the images down the left; one caption at a
 * time (the picture and the one caption editor), or many at once (the tag
 * frequency table and the bulk operations). Every change is saved as a
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
  const [mode, setMode] = useState<Mode>(holder.mode)
  const [filter, setFilter] = useState<ListFilter>('all')
  const [picked, setPicked] = useState<string | null>(holder.current)
  const { heads, marks, shown, counts } = useListing(batch, view, form, entries, filter)
  const picking = usePicking(shown)
  const current = entries.find((e) => e.key === picked) ?? shown[0] ?? entries[0] ?? null
  const keys = shown.map((e) => e.key)

  useEffect(() => {
    holder.current = current?.key ?? null
    holder.mode = mode
  }, [holder, current, mode])

  const pick = (key: string | null) => {
    if (current) void session.flush(current.key)
    setPicked(key)
  }
  const go = (step: 1 | -1) => pick(stepKey(keys, current?.key ?? null, step))
  useEditKeys({
    enabled: mode === 'one',
    go,
    drop: () => {
      if (!current) return
      void session.flush(current.key)
      setPicked(afterRemoval(keys, current.key))
      remove([current.key])
    },
    undo: () => current && session.undo(current.key),
  })

  const body =
    loading || !view || !form ? (
      <p className={styles.empty}>{error ? t('dataset.loadError', { reason: error }) : t('grid.loading')}</p>
    ) : entries.length === 0 || !current ? (
      <p className={styles.empty}>{t('dataset.preview.noImages')}</p>
    ) : (
      <div className={styles.body} data-mode={mode}>
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
          picking={mode === 'bulk' ? picking : undefined}
        />
        {mode === 'one' ? (
          <OneView batch={batch} view={view} form={form} entries={entries} shown={shown} current={current} heads={heads.data} session={session} onGo={go} />
        ) : (
          <BulkView batch={batch} form={form} entries={entries} heads={heads.data} selected={picking.selected} onSelect={picking.set} session={session} />
        )}
      </div>
    )

  return (
    <section className={styles.step} data-testid="edit-step">
      <StepBar count={t('batch.pick.count', { n: entries.length })} hint={mode === 'one' ? t('dataset.edit.hint') : t('dataset.bulk.hint')}>
        <ModeSwitch mode={mode} onMode={setMode} />
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
