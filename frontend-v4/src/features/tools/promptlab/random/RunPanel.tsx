import { useCategories } from '../../../../api/queries'
import { copyText } from '../../../../lib/format'
import { promptTagKeys, segmentPrompt } from '../../../../lib/prompt'
import { useApp } from '../../../../state/store'
import { TagField } from '../../../../ui/TagField'
import { useToasts } from '../../../../ui/toasts'
import { CopyButton } from '../../../card/CardParts'
import { PromptText } from '../../../card/PromptText'
import { tr } from '../../../jobs/jobs'
import { startDraft } from '../buildStore'
import { showInLibrary } from '../libraryActions'
import { withPromptWords } from '../libraryLinks'
import { usePL, type PlKey } from '../plText'
import { writeLike } from '../tagWriting'
import type { TagSet } from '../types'
import type { Quality } from './generateBody'
import { useRuleName, useSetName } from './labels'
import styles from './Random.module.css'
import { setRandom, toggleTagSet, useRandom } from './randomStore'
import { generateNow, keepSeed, randomize, useRandomRun, type RandomResult } from './runRandom'
import { Violations } from './SlotList'
import type { Rule } from './slots'

// 生成: how many prompts, the seed, quality words, the negative, fixed words
// and tag sets; Randomize redraws the unlocked slots, Generate writes one
// prompt from the slots as they are. The prompts come out below.

const QUALITY: { id: Quality; label: PlKey }[] = [
  { id: 'high', label: 'pl.rnd.quality.high' },
  { id: 'medium', label: 'pl.rnd.quality.medium' },
  { id: 'none', label: 'pl.rnd.quality.none' },
]

const words = (text: string) => text.split(',').map((w) => w.trim()).filter(Boolean)

async function copyAll(text: string): Promise<void> {
  if (await copyText(text)) useToasts.getState().push(tr('card.copied'))
}

/** The two actions first, with how many prompts and the seed beside them. */
function RunBar({ pool, rules }: { pool: Record<string, string[]> | undefined; rules: readonly Rule[] }) {
  const p = usePL()
  const count = useRandom((s) => s.count)
  const seed = useRandom((s) => s.seed)
  const canGenerate = useRandom((s) => s.tagSets.length > 0 || Object.values(s.slots).some((tags) => tags.length > 0))
  const running = useRandomRun((s) => s.running)
  return (
    <>
      <div className={styles.runBar}>
        <button type="button" className="btn btn-primary" onClick={() => pool && void randomize(pool, rules)} disabled={!pool || running} title={p('pl.rnd.randomizeTitle', { n: count })} data-testid="pl-randomize">
          {p('pl.rnd.randomize')}
        </button>
        <button type="button" className="btn" onClick={() => void generateNow()} disabled={!canGenerate || running} title={p('pl.rnd.generateTitle')} data-testid="pl-generate">
          {p('pl.rnd.generate')}
        </button>
        <label className={styles.inline}>
          <span>{p('pl.rnd.count')}</span>
          <input
            type="number"
            min={1}
            className={`${styles.input} ${styles.countInput}`}
            value={count}
            onChange={(e) => setRandom({ count: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
            data-testid="pl-count"
          />
        </label>
        <label className={styles.inline}>
          <span>{p('pl.rnd.seed')}</span>
          <input className={`${styles.input} ${styles.seedInput} mono`} value={seed} inputMode="numeric" placeholder={p('pl.rnd.seedPlaceholder')} onChange={(e) => setRandom({ seed: e.target.value })} data-testid="pl-seed" />
        </label>
      </div>
      <p className={styles.muted}>{canGenerate ? p('pl.rnd.seedHint') : `${p('pl.rnd.needTags')} ${p('pl.rnd.seedHint')}`}</p>
    </>
  )
}

function Options() {
  const p = usePL()
  const s = useRandom()
  return (
    <>
      <div className={styles.options}>
        <label className={styles.field}>
          <span className={styles.subLabel}>{p('pl.rnd.quality')}</span>
          <select className={styles.input} value={s.quality} onChange={(e) => setRandom({ quality: e.target.value as Quality })} data-testid="pl-quality">
            {QUALITY.map((q) => (
              <option key={q.id} value={q.id}>
                {p(q.label)}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.check} title={p('pl.rnd.negativeHint')}>
          <input type="checkbox" checked={s.negative} onChange={(e) => setRandom({ negative: e.target.checked })} data-testid="pl-negative" />
          <span>{p('pl.rnd.negative')}</span>
        </label>
      </div>
      <p className={styles.muted}>{p('pl.rnd.qualityHint')}</p>
      <div className={styles.affixes}>
        <label className={styles.field}>
          <span className={styles.subLabel}>{p('pl.rnd.prepend')}</span>
          <TagField className={styles.input} value={s.prepend} onChange={(prepend) => setRandom({ prepend })} write={writeLike(s.prepend)} testId="pl-prepend" />
        </label>
        <label className={styles.field}>
          <span className={styles.subLabel}>{p('pl.rnd.append')}</span>
          <TagField className={styles.input} value={s.append} onChange={(append) => setRandom({ append })} write={writeLike(s.append)} testId="pl-append" />
        </label>
      </div>
      <p className={styles.muted}>{p('pl.rnd.affixHint')}</p>
    </>
  )
}

function SetsInUse({ sets }: { sets: TagSet[] }) {
  const p = usePL()
  const setName = useSetName()
  const inUse = useRandom((s) => s.tagSets)
  const named = inUse.map((id) => {
    const set = sets.find((s) => String(s.id) === id)
    return { id, name: set ? setName(set) : id }
  })
  return (
    <div className={styles.field} data-testid="pl-sets-in-use">
      <span className={styles.subLabel}>{p('pl.rnd.setsInUse')}</span>
      {named.length === 0 ? (
        <span className={styles.muted}>{p('pl.rnd.setsInUseNone')}</span>
      ) : (
        <span className={styles.chipRow}>
          {named.map(({ id, name }) => (
            <span key={id} className="chip">
              {name}
              <button type="button" className={styles.chipX} onClick={() => toggleTagSet(id)} aria-label={p('pl.rnd.remove', { tag: name })}>
                ×
              </button>
            </span>
          ))}
          <span className={styles.muted}>{p('pl.rnd.setsInUseHint')}</span>
        </span>
      )}
    </div>
  )
}

function Result({ r, index, categories }: { r: RandomResult; index: number; categories: Parameters<typeof PromptText>[0]['categories'] }) {
  const p = usePL()
  const ruleName = useRuleName()
  const all = r.negative ? `${r.prompt}\nNegative prompt: ${r.negative}` : r.prompt
  const find = () => showInLibrary(withPromptWords(useApp.getState().queryText, words(r.prompt)), r.prompt)
  return (
    <li className={styles.result} data-testid="pl-result" data-seed={r.seed}>
      <header className={styles.resultHead}>
        <span className={`${styles.muted} mono`}>
          #{index + 1} · {p('pl.rnd.seedOf', { seed: String(r.seed) })}
        </span>
        <button type="button" className={styles.textButton} onClick={() => keepSeed(r.seed)}>
          {p('pl.rnd.keepSeed')}
        </button>
        <span className={styles.resultActions}>
          <CopyButton text={r.prompt} compact />
          <button type="button" className={styles.textButton} onClick={() => void copyAll(all)}>
            {p('pl.build.copyAll')}
          </button>
          <button type="button" className={styles.textButton} onClick={find} data-action="find">
            {p('pl.rnd.find')}
          </button>
          <button type="button" className={styles.textButton} onClick={() => startDraft(words(r.prompt), 'random')} data-action="build">
            {p('pl.act.sendBuild')}
          </button>
        </span>
      </header>
      <div data-testid="pl-result-prompt">
        <PromptText text={r.prompt} categories={categories} />
      </div>
      {r.negative && (
        <p className={styles.negative}>
          <span className={styles.subLabel}>{p('pl.rnd.negativeLabel')}</span> {r.negative}
        </p>
      )}
      {r.violations.length > 0 && <Violations list={r.violations} ruleName={ruleName} />}
    </li>
  )
}

function Results() {
  const p = usePL()
  const { results, running, error } = useRandomRun()
  const keys = results.flatMap((r) => promptTagKeys(segmentPrompt(r.prompt)))
  const { data: categories } = useCategories(keys)
  return (
    <>
      {running && <p className={styles.muted}>{p('pl.rnd.running')}</p>}
      {error && (
        <p className={styles.problem} role="alert">
          {p('pl.rnd.runFailed', { reason: error })}
        </p>
      )}
      {results.length > 0 && (
        <div className={styles.results} aria-busy={running || undefined}>
          <span className={styles.subLabel}>{p('pl.rnd.results')}</span>
          <ol className={styles.resultList}>
            {results.map((r, i) => (
              <Result key={`${r.seed}:${i}`} r={r} index={i} categories={categories} />
            ))}
          </ol>
        </div>
      )}
    </>
  )
}

export function RunPanel({ pool, rules, sets }: { pool: Record<string, string[]> | undefined; rules: readonly Rule[]; sets: TagSet[] }) {
  const p = usePL()
  return (
    <section className={styles.panel} data-testid="pl-run">
      <h3 className={styles.panelTitle}>{p('pl.rnd.options')}</h3>
      <RunBar pool={pool} rules={rules} />
      <Options />
      <SetsInUse sets={sets} />
      <Results />
    </section>
  )
}
