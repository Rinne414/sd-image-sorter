import { useDeferredValue, useId, useMemo } from 'react'
import { useLexicon, useTagCategories } from './lexiconApi'
import { LexiconList, TAG_CATEGORIES, useCategoryName } from './LexiconList'
import styles from './Lexicon.module.css'
import type { LexTab } from './lexiconQuery'
import { shownRows } from './lexiconRows'
import { useLT, type LexKey } from './lexiconText'
import { LEX_TABS, setLexiconView, useLexiconView } from './lexiconView'
import { QueryPanel } from './QueryPanel'

const TAB_KEY: Record<LexTab, LexKey> = { tags: 'lex.tab.tags', prompts: 'lex.tab.prompts', loras: 'lex.tab.loras', checkpoints: 'lex.tab.checkpoints' }
const EMPTY_KEY: Record<LexTab, LexKey> = { tags: 'lex.empty.tags', prompts: 'lex.empty.prompts', loras: 'lex.empty.loras', checkpoints: 'lex.empty.checkpoints' }

function Tabs() {
  const lt = useLT()
  const tab = useLexiconView((s) => s.tab)
  return (
    <div className={styles.tabs} role="tablist">
      {LEX_TABS.map((id) => (
        <button key={id} type="button" role="tab" className={styles.tab} aria-selected={tab === id} onClick={() => setLexiconView({ tab: id })} data-testid={`lex-tab-${id}`}>
          {lt(TAB_KEY[id])}
        </button>
      ))}
    </div>
  )
}

function Controls({ shown, total }: { shown: number; total: number | null }) {
  const lt = useLT()
  const catName = useCategoryName()
  const findId = useId()
  const catId = useId()
  const { tab, sort, find, category } = useLexiconView()
  return (
    <div className={styles.controls}>
      <span className={styles.field}>
        <label className={styles.label} htmlFor={findId}>
          {lt('lex.find')}
        </label>
        <input id={findId} className={styles.input} type="search" value={find} placeholder={lt('lex.find.placeholder')} onChange={(e) => setLexiconView({ find: e.target.value })} data-testid="lex-find" />
      </span>
      <span className={styles.field}>
        <span className={styles.label}>{lt('lex.sort')}</span>
        <span className={styles.sort}>
          {(['count', 'name'] as const).map((s) => (
            <button key={s} type="button" className={styles.sortButton} aria-pressed={sort === s} onClick={() => setLexiconView({ sort: s })} data-testid={`lex-sort-${s}`}>
              {lt(s === 'count' ? 'lex.sort.count' : 'lex.sort.name')}
            </button>
          ))}
        </span>
      </span>
      {tab === 'tags' && (
        <span className={styles.field}>
          <label className={styles.label} htmlFor={catId}>
            {lt('lex.cat.filter')}
          </label>
          <select id={catId} className={styles.select} value={category ?? ''} onChange={(e) => setLexiconView({ category: e.target.value || null })} data-testid="lex-category-filter">
            <option value="">{lt('lex.cat.all')}</option>
            {[...TAG_CATEGORIES, 'rating'].map((c) => (
              <option key={c} value={c}>
                {catName(c)}
              </option>
            ))}
          </select>
        </span>
      )}
      {total !== null && (
        <span className={`${styles.total} mono`} data-testid="lex-total">
          {shown === total ? lt('lex.total', { n: total }) : lt('lex.shown', { shown, total })}
        </span>
      )}
    </div>
  )
}

/** 词库: every tag, prompt word, LoRA and model of the library, by images or by name; a click edits the library search. */
export function LexiconPage() {
  const lt = useLT()
  const { tab, sort, find, category } = useLexiconView()
  const list = useLexicon(tab)
  const tagNames = useMemo(() => (tab === 'tags' ? list.data?.map((r) => r.name) : undefined), [tab, list.data])
  const categories = useTagCategories(tagNames).data
  const deferredFind = useDeferredValue(find)
  const byCategory = tab === 'tags' ? category : null
  const rows = useMemo(
    () => shownRows(list.data ?? [], { find: deferredFind, sort, category: byCategory, categories }),
    [list.data, deferredFind, sort, byCategory, categories],
  )
  const empty = !list.data?.length ? lt(EMPTY_KEY[tab]) : deferredFind.trim() ? lt('lex.noMatch', { q: deferredFind.trim() }) : lt('lex.noCategory')

  return (
    <div className={styles.page} data-testid="lexicon-page" data-tab={tab}>
      <div className={styles.main}>
        <Tabs />
        <Controls shown={rows.length} total={list.data ? list.data.length : null} />
        {list.isError ? (
          <p className={styles.problem}>{lt('lex.loadFailed', { reason: list.error.message })}</p>
        ) : list.data ? (
          <LexiconList tab={tab} rows={rows} categories={categories} empty={empty} />
        ) : (
          <p className={styles.empty}>{lt('lex.loading')}</p>
        )}
      </div>
      <QueryPanel tagsTab={tab === 'tags'} />
    </div>
  )
}
