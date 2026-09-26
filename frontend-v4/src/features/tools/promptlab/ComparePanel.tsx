import { useEffect, useState } from 'react'
import { useCategories, useImageDetail } from '../../../api/queries'
import { thumbnailUrl } from '../../../api/urls'
import { formatScore } from '../../../lib/imageInfo'
import { shortModelName } from '../../../lib/meta'
import { useApp } from '../../../state/store'
import { categoryFor, lookupKey } from './buildCleanup'
import { openBuildImage, startDraft } from './buildStore'
import { ImagePicker } from './ImagePicker'
import { compareProblem, useCompare } from './labApi'
import { seedPicks, setPick, swapPicks, takeSelectionPicks, useComparePicks, type Side } from './labStore'
import { usePL, type PlKey } from './plText'
import styles from './PromptLab.module.css'
import type { CompareResult } from './types'
import type { Categories } from './StatsLists'

// 对比: two images' prompt words and tags side by side — what both have, what
// only one has — and any of the three lists can start a Build draft.

function Slot({ side, id, onPick }: { side: Side; id: number | null; onPick: () => void }) {
  const t = usePL()
  const detail = useImageDetail(id)
  const image = detail.data?.image
  const score = formatScore(image?.aesthetic_score)
  return (
    <div className={styles.slot} data-testid={`pl-compare-${side}`} data-id={id ?? undefined}>
      <span className={styles.subLabel}>{t(side === 'a' ? 'pl.cmp.a' : 'pl.cmp.b')}</span>
      {id === null ? (
        <button type="button" className="btn" onClick={onPick} data-testid={`pl-compare-pick-${side}`}>
          {t('pl.cmp.pick')}
        </button>
      ) : (
        <div className={styles.slotBody}>
          <img className={styles.slotThumb} src={thumbnailUrl(id, 256)} alt="" />
          <div className={styles.slotInfo}>
            <span className={styles.modelName} title={image?.filename} data-testid={`pl-compare-name-${side}`}>
              {image?.filename ?? '…'}
            </span>
            {image?.checkpoint && <span className={styles.muted}>{shortModelName(image.checkpoint)}</span>}
            {score && <span className={`${styles.score} mono`}>{t('pl.stats.score', { score })}</span>}
            <span className={styles.rowActions}>
              <button type="button" className={styles.textButton} onClick={onPick} data-testid={`pl-compare-pick-${side}`}>
                {t('pl.cmp.change')}
              </button>
              <button type="button" className={styles.textButton} onClick={() => void openBuildImage(id)} data-action="build">
                {t('pl.cmp.openBuild')}
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function Words({ title, words, categories, testId }: { title: string; words: string[]; categories: Categories; testId: string }) {
  const t = usePL()
  return (
    <div className={styles.diffCol} data-testid={testId}>
      <header className={styles.panelHead}>
        <span className={styles.subLabel}>{title}</span>
        <span className={`${styles.muted} mono`}>{words.length}</span>
        <button type="button" className={styles.textButton} onClick={() => startDraft(words, 'compare')} disabled={words.length === 0} data-action="draft">
          {t('pl.act.sendBuild')}
        </button>
      </header>
      {words.length === 0 ? (
        <p className={styles.muted}>{t('pl.cmp.none')}</p>
      ) : (
        <span className={styles.chips}>
          {words.map((w) => (
            <span key={w} className={`chip cat-${categoryFor(w, (key) => categories?.get(key))}`}>
              {w}
            </span>
          ))}
        </span>
      )}
    </div>
  )
}

function Diff({ r }: { r: CompareResult }) {
  const t = usePL()
  const all = [...r.prompt_common, ...r.prompt_only_a, ...r.prompt_only_b, ...r.tags_common, ...r.tags_only_a, ...r.tags_only_b]
  const { data: categories } = useCategories(all.map(lookupKey).filter(Boolean))
  const noTags = r.tags_common.length + r.tags_only_a.length + r.tags_only_b.length === 0
  return (
    <>
      <section className={styles.panel} data-testid="pl-compare-prompt">
        <h3 className={styles.panelTitle}>{t('pl.cmp.prompt')}</h3>
        <div className={styles.diffGrid}>
          <Words title={t('pl.cmp.common')} words={r.prompt_common} categories={categories} testId="pl-prompt-common" />
          <Words title={t('pl.cmp.onlyA')} words={r.prompt_only_a} categories={categories} testId="pl-prompt-only-a" />
          <Words title={t('pl.cmp.onlyB')} words={r.prompt_only_b} categories={categories} testId="pl-prompt-only-b" />
        </div>
      </section>
      <section className={styles.panel} data-testid="pl-compare-tags">
        <h3 className={styles.panelTitle}>{t('pl.cmp.tags')}</h3>
        {noTags ? (
          <p className={styles.muted}>{t('pl.cmp.noTags')}</p>
        ) : (
          <div className={styles.diffGrid}>
            <Words title={t('pl.cmp.common')} words={r.tags_common} categories={categories} testId="pl-tags-common" />
            <Words title={t('pl.cmp.onlyA')} words={r.tags_only_a} categories={categories} testId="pl-tags-only-a" />
            <Words title={t('pl.cmp.onlyB')} words={r.tags_only_b} categories={categories} testId="pl-tags-only-b" />
          </div>
        )}
      </section>
    </>
  )
}

const PROBLEM: Record<'missing' | 'notFound', PlKey> = { missing: 'pl.cmp.missing', notFound: 'pl.cmp.notFound' }

function Result({ a, b }: { a: number | null; b: number | null }) {
  const t = usePL()
  const q = useCompare(a, b)
  if (a === null || b === null) return null
  if (a === b) return <p className={styles.warn}>{t('pl.cmp.same')}</p>
  if (q.isPending) return <p className={styles.muted}>{t('pl.cmp.loading')}</p>
  if (q.isError) {
    const problem = compareProblem(q.error)
    const text = problem === 'other' ? t('pl.cmp.failed', { reason: q.error.message }) : t(PROBLEM[problem])
    return (
      <p className={styles.problem} role="alert" data-testid="pl-compare-problem">
        {text}
      </p>
    )
  }
  return <Diff r={q.data} />
}

export function ComparePanel() {
  const t = usePL()
  const { a, b, fromSelection } = useComparePicks()
  const selection = useApp((s) => s.selection)
  const [picking, setPicking] = useState<Side | null>(null)

  useEffect(() => {
    const s = useApp.getState()
    seedPicks(s.selection, s.inspectedId)
  }, [])

  const offerSelection = selection.length >= 2 && (selection[0] !== a || selection[1] !== b)
  return (
    <div className={styles.column} data-testid="pl-compare">
      <p className={styles.lead}>{t('pl.cmp.lead')}</p>
      <div className={styles.slots}>
        <Slot side="a" id={a} onPick={() => setPicking('a')} />
        <button type="button" className="btn btn-ghost" onClick={swapPicks} disabled={a === null && b === null} title={t('pl.cmp.swap')} aria-label={t('pl.cmp.swap')} data-testid="pl-compare-swap">
          ⇄
        </button>
        <Slot side="b" id={b} onPick={() => setPicking('b')} />
      </div>
      {(fromSelection > 2 || offerSelection) && (
        <div className={styles.runRow}>
          {fromSelection > 2 && <span className={styles.muted}>{t('pl.cmp.fromSelection', { n: fromSelection })}</span>}
          {offerSelection && (
            <button type="button" className="btn" onClick={() => takeSelectionPicks(selection)} data-testid="pl-compare-use-selection">
              {t('pl.cmp.useSelection')}
            </button>
          )}
        </div>
      )}
      <Result a={a} b={b} />
      {picking && (
        <ImagePicker
          title={`${t('pl.pick.title')} · ${t(picking === 'a' ? 'pl.cmp.a' : 'pl.cmp.b')}`}
          onPick={(id) => {
            setPick(picking, id)
            setPicking(null)
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  )
}
