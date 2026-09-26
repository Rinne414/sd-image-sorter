import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, thumbnailUrl, unwrap } from '../../api/client'
import type { ImagesPage } from '../../api/types'
import { useT, type MessageKey } from '../../i18n'
import { parseSearch } from '../../lib/searchQuery'
import { useApp } from '../../state/store'
import { FilterPanel } from '../library/FilterPanel'
import { isEverything, SPLITS, type RuleSetup, type RunRecord, type SplitBy } from './rules'
import { FolderLabel } from './SetupParts'
import { SlotFolderDialog } from './SlotFolderDialog'
import styles from './SortPage.module.css'

// The setup of sort by condition: the condition (the library's search
// language, with the library's filter panel), where the images go, the
// subfolder split, a preview of what matches, and the last run of this library.

/** Thumbnails shown in the preview. */
const PREVIEW = 12

interface ConditionProps {
  query: string
  count: number | null
  onQuery: (query: string) => void
  /** Said instead of the count (a condition inside the picks has none to show). */
  note?: string
  testId?: string
}

/** The condition, typed in the library's search language or picked in its filter panel. */
export function ConditionField({ query, count, onQuery, note, testId = 'sort-condition' }: ConditionProps) {
  const t = useT()
  const unread = parseSearch(query).parts.flatMap((p) => (p.kind === 'warn' ? [p.raw] : []))
  return (
    <div className={styles.condition} data-testid={testId}>
      <div className={styles.conditionRow}>
        <input
          className={styles.conditionInput}
          value={query}
          placeholder={t('sort.rules.conditionHint')}
          aria-label={t('sort.rules.conditionLabel')}
          spellCheck={false}
          onChange={(e) => onQuery(e.target.value)}
          data-testid={`${testId}-input`}
        />
        <FilterPanel text={query} onChange={onQuery} />
      </div>
      <p className={!note && isEverything(query) ? styles.warnLine : styles.optionHint} data-testid={`${testId}-count`}>
        {note ?? (isEverything(query) ? t('sort.rules.everything') : count === null ? t('sort.rules.counting') : t('sort.rules.matches', { n: count }))}
      </p>
      {unread.map((raw) => (
        <p key={raw} className={styles.warnLine} role="alert">
          {t('query.warning', { token: raw })}
        </p>
      ))}
    </div>
  )
}

/** Up to twelve of the images the run will take, and a way to see them all in the library. */
export function RulePreview({ params, picks, query }: { params: Record<string, string | number | boolean> | null; picks: number[] | null; query: string }) {
  const t = useT()
  const libraryId = useApp((s) => s.libraryId)
  const page = useQuery({
    queryKey: ['sort-rules-preview', libraryId, params],
    enabled: params !== null,
    queryFn: async ({ signal }) => unwrap<ImagesPage>(await api.GET('/api/images', { params: { query: { ...params, limit: PREVIEW } as never }, signal })),
    staleTime: 30_000,
  })
  const ids = picks ? picks.slice(0, PREVIEW) : (page.data?.images.map((i) => i.id) ?? [])
  const showAll = () => {
    const s = useApp.getState()
    s.setQueryText(query)
    s.setScope({ generators: [], folder: null, favorites: false })
    s.setPage('library')
  }
  return (
    <section className={styles.rulePreview} data-testid="sort-rule-preview">
      <h2 className={styles.section}>{t('sort.rules.preview')}</h2>
      {ids.length === 0 && (params === null || page.isSuccess) ? (
        <p className={styles.note}>{t('sort.rules.previewNone')}</p>
      ) : (
        <div className={styles.thumbs}>
          {ids.map((id) => (
            <img key={id} src={thumbnailUrl(id, 256)} alt="" loading="lazy" decoding="async" draggable={false} />
          ))}
        </div>
      )}
      {!picks && (
        <button type="button" className={styles.link} onClick={showAll}>
          {t('sort.rules.showAll')}
        </button>
      )}
    </section>
  )
}

const SPLIT_NAME: Record<SplitBy, MessageKey> = {
  none: 'sort.rules.split.none',
  generator: 'sort.rules.split.generator',
  checkpoint: 'sort.rules.split.checkpoint',
  rating: 'sort.rules.split.rating',
}
const SPLIT_HINT: Record<SplitBy, MessageKey> = {
  none: 'sort.rules.splitHint.none',
  generator: 'sort.rules.splitHint.generator',
  checkpoint: 'sort.rules.splitHint.checkpoint',
  rating: 'sort.rules.splitHint.rating',
}

export const splitName = (t: ReturnType<typeof useT>, split: SplitBy): string => t(SPLIT_NAME[split])

interface DestProps {
  rule: RuleSetup
  sourceFolder: string | null
  onRule: (rule: RuleSetup) => void
  /** Instead of "Into which folder" (the first of several rules says so). */
  legend?: string
}

/** Where the images go, and how they split into subfolders there. */
export function DestinationPicker({ rule, sourceFolder, onRule, legend }: DestProps) {
  const t = useT()
  const [choosing, setChoosing] = useState(false)
  return (
    <fieldset className={styles.group} data-testid="sort-rule-dest">
      <legend className={styles.section}>{legend ?? t('sort.rules.dest')}</legend>
      <div className={styles.destRow}>
        {rule.destination ? <FolderLabel path={rule.destination} /> : <span className={styles.unset}>{t('sort.rules.destNone')}</span>}
        <button type="button" className="btn" onClick={() => setChoosing(true)} data-testid="sort-rule-choose">
          {t(rule.destination ? 'sort.rules.destChange' : 'sort.rules.destChoose')}
        </button>
      </div>
      <div className={styles.splitRow} role="radiogroup" aria-label={t('sort.rules.split')}>
        <span className={styles.presetsLabel}>{t('sort.rules.split')}</span>
        {SPLITS.map((s) => (
          <label key={s} className={styles.inlineOption}>
            <input type="radio" name="sort-split" checked={rule.splitBy === s} onChange={() => onRule({ ...rule, splitBy: s })} data-testid={`sort-split-${s}`} />
            {t(SPLIT_NAME[s])}
          </label>
        ))}
      </div>
      <p className={styles.note}>{t(SPLIT_HINT[rule.splitBy])}</p>
      {choosing && (
        <SlotFolderDialog
          slot="w"
          title={t('sort.rules.destTitle')}
          current={rule.destination}
          sourceFolder={sourceFolder}
          onChoose={async (path) => {
            onRule({ ...rule, destination: path })
            return true
          }}
          onClose={() => setChoosing(false)}
        />
      )}
    </fieldset>
  )
}

/** The last run of this library, when the page is not showing it: see it, or undo it from there. */
export function LastRunCard({ record, onView }: { record: RunRecord; onView: () => void }) {
  const t = useT()
  const op = t(record.operation === 'copy' ? 'sort.rules.op.copied' : 'sort.rules.op.moved')
  const text =
    record.phase === 'undone'
      ? t('sort.rules.lastUndone')
      : record.groups.length > 1
        ? t('sort.rules.lastRules', { op, n: record.total, rules: record.groups.length })
        : t('sort.rules.last', { op, n: record.total, folder: record.destination })
  return (
    <div className={styles.resume} data-testid="sort-rules-last">
      <div className={styles.resumeText}>
        <span>{text}</span>
      </div>
      <button type="button" className="btn" onClick={onView} data-testid="sort-rules-view">
        {t('sort.rules.view')}
      </button>
    </div>
  )
}
