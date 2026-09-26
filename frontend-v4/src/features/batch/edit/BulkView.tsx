import { useCallback, useMemo, useState } from 'react'
import { useCategories } from '../../../api/queries'
import type { Batch } from '../../../api/types'
import { useT } from '../../../i18n'
import { tagKey as promptKey } from '../../../lib/prompt'
import { Icon } from '../../../ui/Icon'
import { saveProjectSettings } from '../datasetApi'
import { splitList, type DatasetForm } from '../datasetSettings'
import type { CaptionContent, HeadInfo } from '../datasetTag'
import type { Entry } from '../entries'
import styles from './Bulk.module.css'
import { coverageGaps, useBatchContents, useLastBulk, type Gap } from './bulkApi'
import { BulkOps, type BulkContext } from './BulkPanel'
import { runBulk, undoBulk } from './bulkRun'
import { isOwnEmpty, splitTags, tagKey } from './captionContent'
import { hasDuplicateTags, tagFrequency, type BulkOp, type TagRow } from './captionOps'
import type { CaptionSession } from './captionSession'
import { FrequencyTable, type RowActions } from './FrequencyTable'
import { styledTag, styleOf } from './tagStyle'
import { traitMarks } from './tagInsights'

interface Props {
  batch: Batch
  form: DatasetForm
  entries: readonly Entry[]
  heads: ReadonlyMap<string, HeadInfo> | undefined
  selected: ReadonlySet<string>
  onSelect: (keys: Iterable<string>) => void
  session: CaptionSession
}

interface Missed {
  row: TagRow
  gaps: Gap[] | null
  keys: string[]
  error: string | null
}

/** The images a bulk change is for: the selection, or every image that can be edited. */
function useScope(entries: readonly Entry[], selected: ReadonlySet<string>, contents: ReadonlyMap<string, CaptionContent>) {
  return useMemo(() => {
    const keys = entries.filter((e) => contents.has(e.key) && (selected.size === 0 || selected.has(e.key))).map((e) => e.key)
    const rows = tagFrequency(keys.map((k) => [k, contents.get(k) as CaptionContent] as [string, CaptionContent]))
    return { keys, rows }
  }, [entries, selected, contents])
}

/** Bulk mode: the tag frequency table in the middle, the operations on the right. */
export function BulkView({ batch, form, entries, heads, selected, onSelect, session }: Props) {
  const t = useT()
  const { contents, loading, error } = useBatchContents(batch, form, entries, heads, true)
  const { keys, rows } = useScope(entries, selected, contents)
  const categories = useCategories(rows.map((r) => promptKey(r.tag)))
  const categoryOf = useCallback((tag: string) => categories.data?.get(promptKey(tag)) ?? 'unknown', [categories.data])
  const [busy, setBusy] = useState(false)
  const [traits, setTraits] = useState(false)
  const [missed, setMissed] = useState<Missed | null>(null)
  const entryMap = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries])
  const blacklisted = useMemo(() => new Set(splitList(form.blacklist).map(tagKey)), [form.blacklist])
  const scopeLabel = selected.size > 0 ? t('dataset.bulk.scopeSelected', { n: keys.length }) : t('dataset.bulk.scopeAll', { n: keys.length })

  const run = useCallback(
    async (op: BulkOp, label: string, only?: readonly string[]) => {
      setBusy(true)
      try {
        await runBulk(batch, session, { label, op, keys: only ?? keys, initial: contents, entries: entryMap, categoryOf })
      } finally {
        setBusy(false)
      }
    },
    [batch, session, keys, contents, entryMap, categoryOf],
  )
  const style = styleOf(form.normalizeUnderscores)
  const ctx: BulkContext = useMemo(() => ({ contents, keys, categoryOf, style, busy, run: (op, label) => void run(op, label) }), [contents, keys, categoryOf, style, busy, run])

  const actions: RowActions = {
    remove: (row) => void run({ kind: 'remove', tags: [row.tag] }, t('dataset.bulk.labelRemove', { tags: row.tag })),
    blacklist: (row, add) => void setBlacklisted(batch.id, row, add),
    locate: (row) => onSelect(row.keys),
    findMissed: (row) => void findMissed(row, entries, contents, setMissed),
  }

  if (error) return <p className={styles.empty}>{t('dataset.bulk.loadFailed', { reason: error })}</p>
  return (
    <>
      <FrequencyTable
        rows={rows}
        scopeSize={keys.length}
        categories={categories.data}
        blacklisted={blacklisted}
        traits={traits ? traitMarks(rows, keys.length) : null}
        busy={busy || loading}
        actions={actions}
        canFindMissed={entries.some((e) => e.imageId !== null)}
      >
        <div className={styles.tableTools}>
          <button type="button" className="btn btn-ghost" aria-pressed={traits} onClick={() => setTraits(!traits)} data-testid="freq-traits">
            {t('dataset.freq.traits')}
          </button>
          {traits && <span className={styles.muted}>{t('dataset.freq.traitsLead')}</span>}
        </div>
        {missed && <MissedBox missed={missed} busy={busy} onAdd={() => void run({ kind: 'add', tags: [styledTag(missed.row.tag, style)], position: 'back' }, t('dataset.bulk.labelAdd', { tags: missed.row.tag }), missed.keys).then(() => setMissed(null))} onSelect={() => onSelect(missed.keys)} onClose={() => setMissed(null)} />}
        {loading && <p className={styles.muted}>{t('dataset.bulk.loading', { n: entries.length })}</p>}
      </FrequencyTable>
      <aside className={styles.panel} aria-label={t('dataset.bulk.title')} data-testid="bulk-panel">
        <header className={styles.panelHead}>
          <span className={styles.label}>{t('dataset.bulk.title')}</span>
          <span className={styles.scope} data-testid="bulk-scope">{scopeLabel}</span>
        </header>
        <div className={styles.panelScroll}>
          <p className={styles.muted}>{selected.size > 0 ? t('dataset.bulk.scopeHintSelected') : t('dataset.bulk.scopeHintAll')}</p>
          <UndoLast batchId={batch.id} entries={entryMap} busy={busy} />
          <Checks keys={keys} contents={contents} heads={heads} blacklisted={blacklisted} onSelect={onSelect} />
          <BulkOps ctx={ctx} />
        </div>
      </aside>
    </>
  )
}

async function setBlacklisted(batchId: number, row: TagRow, add: boolean): Promise<void> {
  await saveProjectSettings(batchId, (current) => {
    const list = current.caption_render.blacklist
    const next = add ? [...list.filter((tag) => tagKey(tag) !== row.key), row.tag] : list.filter((tag) => tagKey(tag) !== row.key)
    return { ...current, caption_render: { ...current.caption_render, blacklist: next } }
  })
}

async function findMissed(
  row: TagRow,
  entries: readonly Entry[],
  contents: ReadonlyMap<string, CaptionContent>,
  set: (m: Missed | null) => void,
): Promise<void> {
  set({ row, gaps: null, keys: [], error: null })
  const byId = new Map(entries.flatMap((e) => (e.imageId !== null ? [[e.imageId, e] as const] : [])))
  try {
    const gaps = (await coverageGaps(row.tag, [...byId.keys()])).filter((gap) => {
      const entry = byId.get(gap.image_id)
      const content = entry ? contents.get(entry.key) : undefined
      return !!content && !splitTags(content.booru_caption).some((tag) => tagKey(tag) === row.key)
    })
    set({ row, gaps, keys: gaps.map((gap) => (byId.get(gap.image_id) as Entry).key), error: null })
  } catch (error) {
    set({ row, gaps: [], keys: [], error: (error as Error).message })
  }
}

function MissedBox({ missed, busy, onAdd, onSelect, onClose }: { missed: Missed; busy: boolean; onAdd: () => void; onSelect: () => void; onClose: () => void }) {
  const t = useT()
  const n = missed.keys.length
  return (
    <section className={styles.missed} aria-label={t('dataset.freq.missedTitle', { tag: missed.row.tag })} data-testid="freq-missed-box">
      <header className={styles.missedHead}>
        <span className={styles.label}>{t('dataset.freq.missedTitle', { tag: missed.row.tag })}</span>
        <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
          <Icon name="close" size={12} />
        </button>
      </header>
      {missed.error ? (
        <p className={styles.problem}>{t('dataset.freq.missedFailed', { reason: missed.error })}</p>
      ) : !missed.gaps ? (
        <p className={styles.muted}>{t('grid.loading')}</p>
      ) : n === 0 ? (
        <p className={styles.muted}>{t('dataset.freq.missedNone')}</p>
      ) : (
        <>
          <p className={styles.muted} data-testid="freq-missed-count">
            {t('dataset.freq.missedFound', { n })}
          </p>
          <p className={`${styles.missedList} mono`}>{missed.gaps.map((g) => `${g.filename} (${Math.round(g.score * 100)})`).join(' · ')}</p>
          <div className={styles.actions}>
            <button type="button" className="btn" disabled={busy} onClick={onAdd} data-testid="freq-missed-add">
              {t('dataset.freq.missedAdd', { n })}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onSelect}>
              {t('dataset.freq.missedSelect')}
            </button>
          </div>
          <p className={styles.muted}>{t('dataset.freq.missedNote')}</p>
        </>
      )}
    </section>
  )
}

function UndoLast({ batchId, entries, busy }: { batchId: number; entries: ReadonlyMap<string, Entry>; busy: boolean }) {
  const t = useT()
  const last = useLastBulk((s) => s.last[batchId] ?? null)
  const [undoing, setUndoing] = useState(false)
  if (!last) return null
  return (
    <button
      type="button"
      className="btn"
      disabled={busy || undoing}
      onClick={async () => {
        setUndoing(true)
        await undoBulk(batchId, last, entries)
        setUndoing(false)
      }}
      data-testid="bulk-undo"
    >
      <Icon name="undo" size={14} />
      {t('dataset.bulk.undoLast', { what: last.label, n: last.written.length })}
    </button>
  )
}

/** What stands out in the scope, each a click away from being the selection. */
function Checks({
  keys,
  contents,
  heads,
  blacklisted,
  onSelect,
}: {
  keys: readonly string[]
  contents: ReadonlyMap<string, CaptionContent>
  heads: ReadonlyMap<string, HeadInfo> | undefined
  blacklisted: ReadonlySet<string>
  onSelect: (keys: Iterable<string>) => void
}) {
  const t = useT()
  const groups = useMemo(() => {
    const pick = (test: (c: CaptionContent, key: string) => boolean) => keys.filter((k) => test(contents.get(k) as CaptionContent, k))
    return [
      { id: 'edited', label: 'dataset.bulk.checkEdited' as const, keys: pick((_c, k) => heads?.get(k)?.author === 'user') },
      { id: 'empty', label: 'dataset.bulk.checkEmpty' as const, keys: pick((c) => isOwnEmpty(c)) },
      { id: 'dupes', label: 'dataset.bulk.checkDupes' as const, keys: pick((c) => hasDuplicateTags(c)) },
      { id: 'listed', label: 'dataset.bulk.checkListed' as const, keys: pick((c) => splitTags(c.booru_caption).some((tag) => blacklisted.has(tagKey(tag)))) },
    ]
  }, [keys, contents, heads, blacklisted])
  return (
    <div className={styles.checks} data-testid="bulk-checks">
      {groups.map((g) => (
        <button key={g.id} type="button" className={styles.checkButton} disabled={g.keys.length === 0} onClick={() => onSelect(g.keys)} title={t('dataset.bulk.checkSelect')} data-testid={`bulk-check-${g.id}`}>
          {t(g.label)} <span className="mono">{g.keys.length}</span>
        </button>
      ))}
    </div>
  )
}
