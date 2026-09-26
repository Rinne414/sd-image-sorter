import { useEffect, useState } from 'react'
import { useImageDetail } from '../../../api/queries'
import { thumbnailUrl } from '../../../api/urls'
import { formatScore } from '../../../lib/imageInfo'
import { shortModelName } from '../../../lib/meta'
import { useApp } from '../../../state/store'
import { CopyButton } from '../../card/CardParts'
import { arrangeByGroup, cleanTags, lookupKey, splitPrompt } from './buildCleanup'
import { clearBuild, openBuildImage, replacePrompt, setNegative, setPrompt, useBuild, type BuildOrigin } from './buildStore'
import { ImagePicker } from './ImagePicker'
import { fetchCategories } from './labApi'
import { plt, usePL, type PlKey } from './plText'
import styles from './PromptLab.module.css'
import { RecipeBlock } from './RecipeBlock'

// 构建: one image's prompt (or a draft) to edit, sort by tag group, clean up
// and copy.

type Cleanup = 'clean' | 'dropQuality' | 'spaces' | 'reorder'

const CLEANUPS: { id: Cleanup; label: PlKey }[] = [
  { id: 'clean', label: 'pl.build.clean' },
  { id: 'dropQuality', label: 'pl.build.dropQuality' },
  { id: 'spaces', label: 'pl.build.spaces' },
  { id: 'reorder', label: 'pl.build.reorder' },
]

async function runCleanup(kind: Cleanup): Promise<void> {
  const before = splitPrompt(useBuild.getState().prompt)
  let next = cleanTags(before, { spaces: kind === 'spaces' })
  if (kind === 'dropQuality' || kind === 'reorder') {
    const categories = await fetchCategories(next.map(lookupKey).filter(Boolean))
    next = arrangeByGroup(next, (key) => categories.get(key), { dropQuality: kind === 'dropQuality' })
  }
  replacePrompt(next.join(', '), plt('pl.build.cleaned', { before: before.length, after: next.length }))
}

function SourceImage({ id }: { id: number }) {
  const t = usePL()
  const image = useImageDetail(id).data?.image
  const score = formatScore(image?.aesthetic_score)
  const facts = [image?.checkpoint ? shortModelName(image.checkpoint) : '', image?.width && image.height ? `${image.width}×${image.height}` : '', score ? t('pl.stats.score', { score }) : '']
  return (
    <>
      <img className={styles.sourceThumb} src={thumbnailUrl(id, 256)} alt="" />
      <span className={styles.sourceText}>
        <span className={styles.subLabel}>{t('pl.build.source')}</span>
        <span className={styles.modelName} title={image?.filename} data-testid="pl-build-source-name">
          {image?.filename ?? '…'}
        </span>
        <span className={`${styles.muted} mono`}>{facts.filter(Boolean).join(' · ')}</span>
      </span>
    </>
  )
}

function originText(origin: BuildOrigin): string {
  if (origin?.kind !== 'draft') return ''
  if (origin.from === 'recipe') return plt('pl.build.draftFrom.recipe', { name: origin.name ?? '' })
  return plt(origin.from === 'compare' ? 'pl.build.draftFrom.compare' : 'pl.build.draftFrom.stats')
}

/** The image being looked at in the library, offered when Build has another source. */
function UseViewed({ origin }: { origin: BuildOrigin }) {
  const t = usePL()
  const viewed = useApp((s) => s.inspectedId)
  const name = useImageDetail(viewed).data?.image.filename
  if (viewed === null || (origin?.kind === 'image' && origin.id === viewed)) return null
  return (
    <button type="button" className="btn" onClick={() => void openBuildImage(viewed)} data-testid="pl-build-use-viewed">
      {t('pl.build.useViewed', { name: name ?? '…' })}
    </button>
  )
}

function SourceBar({ onPick }: { onPick: () => void }) {
  const t = usePL()
  const origin = useBuild((s) => s.origin)
  const hasText = useBuild((s) => !!(s.prompt || s.negative))
  return (
    <div className={styles.sourceBar} data-testid="pl-build-source" data-origin={origin?.kind ?? 'none'}>
      {origin?.kind === 'image' && <SourceImage id={origin.id} />}
      {origin?.kind === 'draft' && (
        <span className={styles.sourceText}>
          <span className={styles.subLabel}>{t('pl.build.draft')}</span>
          <span className={styles.modelName}>{originText(origin)}</span>
        </span>
      )}
      {!origin && <p className={styles.lead}>{t('pl.build.lead')}</p>}
      <span className={styles.sourceActions}>
        <UseViewed origin={origin} />
        <button type="button" className="btn" onClick={onPick} data-testid="pl-build-pick">
          {t(origin?.kind === 'image' ? 'pl.build.change' : 'pl.build.pick')}
        </button>
        {(origin || hasText) && (
          <button type="button" className="btn btn-ghost" onClick={clearBuild} data-testid="pl-build-clear">
            {t('pl.build.clear')}
          </button>
        )}
      </span>
    </div>
  )
}

function Editor() {
  const t = usePL()
  const prompt = useBuild((s) => s.prompt)
  const negative = useBuild((s) => s.negative)
  const empty = !prompt.trim()
  const all = negative.trim() ? `${prompt}\nNegative prompt: ${negative}` : prompt
  return (
    <section className={styles.panel} data-testid="pl-build-editor">
      <header className={styles.panelHead}>
        <label className={styles.panelTitle} htmlFor="pl-build-prompt">
          {t('pl.build.prompt')}
        </label>
        <CopyButton text={prompt} compact testId="pl-build-copy" />
      </header>
      <textarea id="pl-build-prompt" className={styles.textarea} rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)} spellCheck={false} data-testid="pl-build-prompt" />
      <label className={styles.subLabel} htmlFor="pl-build-negative">
        {t('pl.build.negative')}
      </label>
      <textarea id="pl-build-negative" className={styles.textarea} rows={3} value={negative} onChange={(e) => setNegative(e.target.value)} spellCheck={false} data-testid="pl-build-negative" />
      <div className={styles.runRow}>
        <CopyButton text={prompt} label={t('pl.build.copy')} testId="pl-build-copy-prompt" />
        <CopyButton text={all} label={t('pl.build.copyAll')} testId="pl-build-copy-all" />
      </div>
      <span className={styles.subLabel}>{t('pl.build.cleanup')}</span>
      <div className={styles.runRow}>
        {CLEANUPS.map(({ id, label }) => (
          <button key={id} type="button" className="btn" onClick={() => void runCleanup(id)} disabled={empty} data-testid={`pl-build-${id}`}>
            {t(label)}
          </button>
        ))}
      </div>
      <p className={styles.muted}>{t('pl.build.cleanNote')}</p>
    </section>
  )
}

/** The value once it has stopped changing for a moment (typing does not ask the server on every key). */
function useSettled<T>(value: T, ms = 400): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setSettled(value), ms)
    return () => window.clearTimeout(id)
  }, [value, ms])
  return settled
}

/** The tags the groups show: the library's tags for an image that has them, else the prompt's words. */
function useRecipeTags(): { tags: string[]; fromPrompt: boolean } {
  const origin = useBuild((s) => s.origin)
  const prompt = useSettled(useBuild((s) => s.prompt))
  const detail = useImageDetail(origin?.kind === 'image' ? origin.id : null)
  const libraryTags = detail.data?.tags.map((row) => row.tag) ?? []
  if (libraryTags.length) return { tags: libraryTags, fromPrompt: false }
  return { tags: splitPrompt(prompt).filter((w) => lookupKey(w)), fromPrompt: true }
}

export function BuildPanel() {
  const t = usePL()
  const loading = useBuild((s) => s.loading)
  const error = useBuild((s) => s.error)
  const [picking, setPicking] = useState(false)
  const recipe = useRecipeTags()
  return (
    <div className={styles.column} data-testid="pl-build">
      <SourceBar onPick={() => setPicking(true)} />
      {loading && <p className={styles.muted}>{t('pl.build.loading')}</p>}
      {error && (
        <p className={styles.problem} role="alert">
          {t('pl.build.loadFailed', { reason: error })}
        </p>
      )}
      <div className={styles.buildGrid}>
        <Editor />
        <RecipeBlock tags={recipe.tags} fromPrompt={recipe.fromPrompt} />
      </div>
      {picking && (
        <ImagePicker
          title={t('pl.pick.title')}
          onPick={(id) => {
            setPicking(false)
            void openBuildImage(id)
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  )
}
