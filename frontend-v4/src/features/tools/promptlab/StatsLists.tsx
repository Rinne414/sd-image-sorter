import type { ReactNode } from 'react'
import type { TagCategory } from '../../../api/types'
import { thumbnailUrl } from '../../../api/urls'
import { shortModelName } from '../../../lib/meta'
import { useApp } from '../../../state/store'
import { sendToTool } from '../handoff'
import { addToBuild, openBuildImage, startDraft } from './buildStore'
import { openInLibrary, showInLibrary } from './libraryActions'
import { withCheckpoint, withRecipe, withTag } from './libraryLinks'
import { sendToRandom } from './random/runRandom'
import { usePL, type PlKey } from './plText'
import styles from './PromptLab.module.css'
import type { CheckpointCount, CheckpointLeader, CheckpointRecipe, ScoredExample, TagCount } from './types'

// The lists on the Stats page. Every "筛到图库" only edits the library's
// search text; "加入构建" / "送去构建" fill Build, "用于随机" fills Random's slots.

export type Categories = Map<string, TagCategory> | undefined

const score = (n: number | null | undefined) => (n === null || n === undefined ? '' : n.toFixed(2))

function filterTag(tag: string): void {
  showInLibrary(withTag(useApp.getState().queryText, tag), tag)
}

function filterModel(name: string): void {
  showInLibrary(withCheckpoint(useApp.getState().queryText, name), shortModelName(name))
}

function tryRecipe(recipe: CheckpointRecipe): void {
  showInLibrary(withRecipe(useApp.getState().queryText, recipe.name, recipe.tags), [shortModelName(recipe.name), ...recipe.tags].join(', '))
}

export function Panel({ title, count, note, children, testId }: { title: string; count?: number; note?: string; children: ReactNode; testId: string }) {
  return (
    <section className={styles.panel} data-testid={testId}>
      <header className={styles.panelHead}>
        <h3 className={styles.panelTitle}>{title}</h3>
        {count !== undefined && <span className={`${styles.muted} mono`}>{count.toLocaleString()}</span>}
      </header>
      {note && <p className={styles.muted}>{note}</p>}
      {children}
    </section>
  )
}

export function More({ total, shown, onMore, testId }: { total: number; shown: number; onMore: () => void; testId: string }) {
  const t = usePL()
  if (total <= shown) return null
  return (
    <button type="button" className={`${styles.textButton} ${styles.more}`} onClick={onMore} data-testid={testId}>
      {t('pl.stats.more', { n: total - shown })}
    </button>
  )
}

interface TagListProps {
  rows: TagCount[]
  shown: number
  categories: Categories
  /** What the number after the bar says. */
  value: (row: TagCount) => string
  empty: string
  testId: string
}

export function TagList({ rows, shown, categories, value, empty, testId }: TagListProps) {
  const t = usePL()
  if (rows.length === 0) return <p className={styles.muted}>{empty}</p>
  const max = rows[0]?.count || 1
  return (
    <ul className={styles.rows} data-testid={testId}>
      {rows.slice(0, shown).map((row) => (
        <li key={row.tag} className={styles.row} data-tag={row.tag}>
          <span className={`${styles.rowName} cat-${categories?.get(row.tag) ?? 'unknown'}`} title={row.tag}>
            {row.tag}
          </span>
          <span className={styles.bar} aria-hidden>
            <span className={styles.barFill} style={{ width: `${Math.max(2, (row.count / max) * 100)}%` }} />
          </span>
          <span className={`${styles.rowValue} mono`}>{value(row)}</span>
          <span className={styles.rowActions}>
            <button type="button" className={styles.textButton} onClick={() => filterTag(row.tag)} data-action="filter">
              {t('pl.act.filter')}
            </button>
            <button type="button" className={styles.textButton} onClick={() => addToBuild([row.tag])} data-action="build">
              {t('pl.act.toBuild')}
            </button>
            <button type="button" className={styles.textButton} onClick={() => void sendToRandom([row.tag])} data-action="random">
              {t('pl.act.toRandom')}
            </button>
          </span>
        </li>
      ))}
    </ul>
  )
}

export function ModelList({ rows, shown, empty, testId }: { rows: CheckpointCount[]; shown: number; empty: ReactNode; testId: string }) {
  const t = usePL()
  if (rows.length === 0) return <>{empty}</>
  return (
    <ul className={styles.rows} data-testid={testId}>
      {rows.slice(0, shown).map((row) => (
        <li key={row.name} className={styles.modelRow} data-model={row.name}>
          <span className={styles.rowName} title={row.name}>
            {shortModelName(row.name)}
          </span>
          <span className={`${styles.rowValue} mono`}>{t('pl.stats.images', { n: row.count })}</span>
          <span className={styles.rowActions}>
            <button type="button" className={styles.textButton} onClick={() => filterModel(row.name)} data-action="filter">
              {t('pl.act.filter')}
            </button>
          </span>
        </li>
      ))}
    </ul>
  )
}

function RecipeTags({ tags, categories }: { tags: string[]; categories: Categories }) {
  if (tags.length === 0) return null
  return (
    <span className={styles.chips}>
      {tags.slice(0, 8).map((tag) => (
        <span key={tag} className={`chip cat-${categories?.get(tag) ?? 'unknown'}`}>
          {tag}
        </span>
      ))}
    </span>
  )
}

function ModelCard({ name, meta, tags, categories, actions }: { name: string; meta: string; tags: string[]; categories: Categories; actions: ReactNode }) {
  return (
    <li className={styles.modelCard} data-model={name}>
      <div className={styles.modelCardHead}>
        <span className={styles.modelName} title={name}>
          {shortModelName(name)}
        </span>
        <span className={`${styles.muted} mono`}>{meta}</span>
      </div>
      <RecipeTags tags={tags} categories={categories} />
      <div className={styles.rowActions}>{actions}</div>
    </li>
  )
}

function useMeta() {
  const t = usePL()
  return (avg: number | null, count: number) =>
    [avg !== null ? t('pl.stats.avg', { score: score(avg) }) : '', t('pl.stats.images', { n: count })].filter(Boolean).join(' · ')
}

export function LeaderList(props: { rows: CheckpointLeader[]; recipes: CheckpointRecipe[]; shown: number; categories: Categories; empty: ReactNode }) {
  const t = usePL()
  const meta = useMeta()
  if (props.rows.length === 0) return <>{props.empty}</>
  return (
    <ul className={styles.cards} data-testid="pl-best-models">
      {props.rows.slice(0, props.shown).map((row) => {
        const tags = props.recipes.find((r) => r.name === row.name)?.tags ?? []
        const actions = (
          <>
            <button type="button" className={styles.textButton} onClick={() => filterModel(row.name)} data-action="filter">
              {t('pl.act.filter')}
            </button>
            <button type="button" className={styles.textButton} onClick={() => void sendToRandom(tags)} disabled={tags.length === 0} data-action="random">
              {t('pl.act.toRandom')}
            </button>
            <button type="button" className={styles.textButton} onClick={() => startDraft(tags, 'recipe', shortModelName(row.name))} disabled={tags.length === 0} data-action="build">
              {t('pl.act.sendBuild')}
            </button>
          </>
        )
        return <ModelCard key={row.name} name={row.name} meta={meta(row.avg_score, row.count)} tags={tags} categories={props.categories} actions={actions} />
      })}
    </ul>
  )
}

export function RecipeList({ rows, shown, categories, empty }: { rows: CheckpointRecipe[]; shown: number; categories: Categories; empty: ReactNode }) {
  const t = usePL()
  const meta = useMeta()
  if (rows.length === 0) return <>{empty}</>
  return (
    <ul className={styles.cards} data-testid="pl-recipes">
      {rows.slice(0, shown).map((row) => {
        const actions = (
          <>
            <button type="button" className={styles.textButton} onClick={() => tryRecipe(row)} data-action="filter">
              {t('pl.act.tryInLibrary')}
            </button>
            <button type="button" className={styles.textButton} onClick={() => void sendToRandom(row.tags)} disabled={row.tags.length === 0} data-action="random">
              {t('pl.act.toRandom')}
            </button>
            <button type="button" className={styles.textButton} onClick={() => startDraft(row.tags, 'recipe', shortModelName(row.name))} disabled={row.tags.length === 0} data-action="build">
              {t('pl.act.sendBuild')}
            </button>
          </>
        )
        return <ModelCard key={row.name} name={row.name} meta={meta(row.avg_score, row.count)} tags={row.tags} categories={categories} actions={actions} />
      })}
    </ul>
  )
}

function Example({ row }: { row: ScoredExample }) {
  const t = usePL()
  const act = (key: PlKey, run: () => void, action: string) => (
    <button type="button" className={styles.textButton} onClick={run} data-action={action}>
      {t(key)}
    </button>
  )
  return (
    <li className={styles.example} data-id={row.id}>
      <img className={styles.exampleThumb} src={thumbnailUrl(row.id, 320)} alt="" loading="lazy" />
      <div className={styles.exampleMain}>
        <div className={styles.modelCardHead}>
          <span className={styles.modelName} title={row.filename}>
            {row.filename}
          </span>
          <span className={`${styles.score} mono`}>{t('pl.stats.score', { score: score(row.aesthetic_score) })}</span>
        </div>
        {row.checkpoint && <span className={styles.muted}>{shortModelName(row.checkpoint)}</span>}
        <p className={styles.examplePrompt}>{row.prompt || t('pl.stats.noPromptText')}</p>
        <div className={styles.rowActions}>
          {act('pl.act.openInLibrary', () => openInLibrary(row.id), 'library')}
          {act('pl.act.reader', () => sendToTool('reader', [row.id]), 'reader')}
          {act('pl.act.build', () => void openBuildImage(row.id), 'build')}
        </div>
      </div>
    </li>
  )
}

export function ExampleList({ rows, shown, empty }: { rows: ScoredExample[]; shown: number; empty: string }) {
  if (rows.length === 0) return <p className={styles.muted}>{empty}</p>
  return (
    <ul className={styles.examples} data-testid="pl-examples">
      {rows.slice(0, shown).map((row) => (
        <Example key={row.id} row={row} />
      ))}
    </ul>
  )
}
