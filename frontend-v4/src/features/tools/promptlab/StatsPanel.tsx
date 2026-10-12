import { useState } from 'react'
import { useCategories } from '../../../api/queries'
import { usePL, type PlKey } from './plText'
import { FIRST_VISIBLE, MORE_STEP, usePromptStats, type Visible } from './labApi'
import styles from './PromptLab.module.css'
import { ExampleList, LeaderList, ModelList, More, Panel, RecipeList, TagList } from './StatsLists'
import type { CheckpointEmptyReason, PromptStats } from './types'

// 统计: what the library uses most and what scores best, each with a way into
// the library search or into Build.

function Card({ label, value, note, testId }: { label: string; value: string; note: string; testId: string }) {
  return (
    <div className={styles.statCard} data-testid={testId}>
      <span className={styles.subLabel}>{label}</span>
      <span className={`${styles.statValue} mono`}>{value}</span>
      <span className={styles.muted}>{note}</span>
    </div>
  )
}

function StatCards({ s }: { s: PromptStats }) {
  const t = usePL()
  const caption = s.caption_length
  const pct = s.total_images ? Math.round((s.scored_images / s.total_images) * 100) : 0
  const totalNote = [s.usable_images !== s.total_images ? t('pl.stats.totalNote', { n: s.usable_images }) : '', t('pl.stats.tagged', { n: s.tagged_images })]
  return (
    <div className={styles.statCards}>
      <Card label={t('pl.stats.total')} value={s.total_images.toLocaleString()} note={totalNote.filter(Boolean).join(' · ')} testId="pl-stat-total" />
      <Card label={t('pl.stats.scored')} value={s.scored_images.toLocaleString()} note={t('pl.stats.scoredNote', { pct })} testId="pl-stat-scored" />
      <Card label={t('pl.stats.promptLen')} value={s.prompt_length.avg.toLocaleString()} note={t('pl.stats.promptLenNote', { n: s.prompt_length.sample })} testId="pl-stat-prompt" />
      {/* No caption recorded yet is not an average of 0: the card waits for a real sample. */}
      {caption.available && caption.sample > 0 && (
        <Card label={t('pl.stats.captionLen')} value={caption.avg.toLocaleString()} note={t('pl.stats.captionNote', { n: caption.sample })} testId="pl-stat-caption" />
      )}
    </div>
  )
}

const EMPTY_KEY: Record<CheckpointEmptyReason, PlKey> = {
  no_checkpoint_metadata: 'pl.empty.no_checkpoint_metadata',
  checkpoint_metadata_only_on_missing_files: 'pl.empty.checkpoint_metadata_only_on_missing_files',
  no_scored_images: 'pl.empty.no_scored_images',
  not_enough_scored_images_per_checkpoint: 'pl.empty.not_enough_scored_images_per_checkpoint',
}

/** An empty model list says why; the scan offer comes only when the backend found it would help. */
function ModelEmpty({ s, reason }: { s: PromptStats; reason: CheckpointEmptyReason | null }) {
  const t = usePL()
  const c = s.checkpoint_coverage
  const known = reason ? EMPTY_KEY[reason] : undefined
  const fact = known ? t(known, { n: c.images_with_checkpoint_any, min: c.min_scored_images_per_checkpoint, scored: c.scored_usable_images }) : t('pl.empty.unknown')
  return (
    <div className={styles.empty} data-testid="pl-model-empty">
      <p className={styles.muted}>{fact}</p>
      {known && s.checkpoint_empty_action === 'scan_generated_images_folder' && <p className={styles.offer}>{t('pl.empty.scanOffer')}</p>}
    </div>
  )
}

function Lists({ s, shown, more }: { s: PromptStats; shown: Visible; more: (k: keyof Visible) => void }) {
  const t = usePL()
  const tags = [
    ...s.top_tags.slice(0, shown.tags).map((r) => r.tag),
    ...s.high_aesthetic_tags.slice(0, shown.high).map((r) => r.tag),
    ...s.checkpoint_recipes.flatMap((r) => r.tags.slice(0, 8)),
  ]
  const { data: categories } = useCategories(tags)
  const pct = (row: { pct?: number }) => `${row.pct ?? 0}%`
  const count = (row: { count: number }) => row.count.toLocaleString()
  return (
    <div className={styles.statGrid}>
      <Panel title={t('pl.stats.topTags')} count={s.top_tags_total} note={t('pl.stats.topTagsNote', { n: s.top_tags_denominator })} testId="pl-panel-top-tags">
        <TagList rows={s.top_tags} shown={shown.tags} categories={categories} value={pct} empty={t('pl.stats.noTags')} testId="pl-top-tags" />
        <More total={s.top_tags_total} shown={Math.min(shown.tags, s.top_tags_total)} onMore={() => more('tags')} testId="pl-top-tags-more" />
      </Panel>
      <Panel title={t('pl.stats.highTags')} count={s.high_aesthetic_tags_total} note={t('pl.stats.highTagsNote')} testId="pl-panel-high-tags">
        <TagList rows={s.high_aesthetic_tags} shown={shown.high} categories={categories} value={count} empty={t('pl.stats.noHighTags')} testId="pl-high-tags" />
        <More total={s.high_aesthetic_tags_total} shown={Math.min(shown.high, s.high_aesthetic_tags_total)} onMore={() => more('high')} testId="pl-high-tags-more" />
      </Panel>
      <Panel title={t('pl.stats.topModels')} count={s.top_checkpoints_total} testId="pl-panel-top-models">
        <ModelList rows={s.top_checkpoints} shown={shown.models} empty={<ModelEmpty s={s} reason={s.top_checkpoints_empty_reason} />} testId="pl-top-models" />
        <More total={s.top_checkpoints_total} shown={Math.min(shown.models, s.top_checkpoints_total)} onMore={() => more('models')} testId="pl-top-models-more" />
      </Panel>
      <Panel
        title={t('pl.stats.bestModels')}
        count={s.checkpoint_score_leaders_total}
        note={t('pl.stats.bestModelsNote', { min: s.checkpoint_coverage.min_scored_images_per_checkpoint })}
        testId="pl-panel-best-models"
      >
        <LeaderList rows={s.checkpoint_score_leaders} recipes={s.checkpoint_recipes} shown={shown.leaders} categories={categories} empty={<ModelEmpty s={s} reason={s.checkpoint_score_leaders_empty_reason} />} />
        <More total={s.checkpoint_score_leaders_total} shown={Math.min(shown.leaders, s.checkpoint_score_leaders_total)} onMore={() => more('leaders')} testId="pl-best-models-more" />
      </Panel>
      <Panel title={t('pl.stats.recipes')} count={s.checkpoint_recipes_total} note={t('pl.stats.recipesNote')} testId="pl-panel-recipes">
        <RecipeList rows={s.checkpoint_recipes} shown={shown.recipes} categories={categories} empty={<ModelEmpty s={s} reason={s.checkpoint_recipes_empty_reason} />} />
        <More total={s.checkpoint_recipes_total} shown={Math.min(shown.recipes, s.checkpoint_recipes_total)} onMore={() => more('recipes')} testId="pl-recipes-more" />
      </Panel>
    </div>
  )
}

export function StatsPanel() {
  const t = usePL()
  const [shown, setShown] = useState<Visible>(FIRST_VISIBLE)
  const q = usePromptStats(shown)
  const more = (k: keyof Visible) => setShown((v) => ({ ...v, [k]: v[k] + MORE_STEP[k] }))
  if (q.isPending) return <p className={styles.muted}>{t('pl.stats.loading')}</p>
  if (q.isError) {
    return (
      <div className={styles.problemBox} role="alert">
        <p className={styles.problem}>{t('pl.stats.failed', { reason: q.error.message })}</p>
        <button type="button" className="btn" onClick={() => void q.refetch()}>
          {t('pl.stats.retry')}
        </button>
      </div>
    )
  }
  return (
    <div className={styles.stats} data-testid="pl-stats">
      <StatCards s={q.data} />
      <Lists s={q.data} shown={shown} more={more} />
      <Panel title={t('pl.stats.examples')} count={q.data.top_scored_images_total} testId="pl-panel-examples">
        <ExampleList rows={q.data.top_scored_images} shown={shown.examples} empty={t('pl.stats.noExamples')} />
        <More total={q.data.top_scored_images_total} shown={Math.min(shown.examples, q.data.top_scored_images_total)} onMore={() => more('examples')} testId="pl-examples-more" />
      </Panel>
    </div>
  )
}
