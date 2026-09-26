import { useEffect, useId, useState } from 'react'
import { useT } from '../../../i18n'
import { useJobs } from '../../jobs/jobs'
import { useSaved } from '../useSaved'
import { BulkDialog } from './BulkDialog'
import { useModelQueue } from './bulkRun'
import { useModelFocus } from './focus'
import styles from './ModelCenter.module.css'
import { ModelCard } from './ModelCard'
import { groupCards, summarize, type Summary } from './modelCards'
import { saveMirror, useMirror, useModelCards } from './modelsApi'
import { useMT, type ModelKey } from './modelText'
import { RestartBanner } from './RestartBanner'
import type { ModelCenterCard } from './types'

const FOCUS_MS = 2400

/** Settings › 模型中心: what is ready, what downloads on first use, the download source, and one card per model. */
export function ModelCenterTab() {
  const mt = useMT()
  const status = useModelCards()
  const [bulkOpen, setBulkOpen] = useState(false)
  const cards = status.data?.models ?? []
  const lit = useFocusedCard(cards)

  if (status.isPending) return <p className={styles.state}>{mt('mc.loading')}</p>
  if (status.isError) {
    return (
      <div className={styles.page}>
        <p className={styles.state} data-tone="error">
          {mt('mc.failed', { reason: status.error.message })}
        </p>
        <button type="button" onClick={() => void status.refetch()} className={`btn ${styles.retry}`}>
          {mt('mc.retry')}
        </button>
      </div>
    )
  }
  const { essentials, others } = groupCards(cards)
  return (
    <div className={styles.page} data-testid="model-center">
      <RestartBanner cards={cards} />
      <Overview summary={summarize(cards)} onBulk={() => setBulkOpen(true)} />
      <Explainer />
      <MirrorChoice />
      <CardGroup title="mc.group.essentials" cards={essentials} lit={lit} testId="model-group-essentials" />
      <CardGroup title="mc.group.others" cards={others} lit={lit} testId="model-group-others" />
      {bulkOpen && <BulkDialog onClose={() => setBulkOpen(false)} />}
    </div>
  )
}

/** Arriving from "Which one should I pick?": that card is scrolled to, focused and marked for a moment. */
function useFocusedCard(cards: readonly ModelCenterCard[]): string | null {
  const wanted = useModelFocus((s) => s.card)
  const [lit, setLit] = useState<string | null>(null)
  const ready = cards.length > 0
  useEffect(() => {
    if (!wanted || !ready) return
    useModelFocus.setState({ card: null })
    const el = document.querySelector<HTMLElement>(`[data-card="${CSS.escape(wanted)}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'start' })
    el.focus({ preventScroll: true })
    setLit(wanted)
  }, [wanted, ready])
  useEffect(() => {
    if (!lit) return
    const timer = window.setTimeout(() => setLit(null), FOCUS_MS)
    return () => window.clearTimeout(timer)
  }, [lit])
  return lit
}

function Overview({ summary, onBulk }: { summary: Summary; onBulk: () => void }) {
  const mt = useMT()
  const queue = useModelQueue()
  const stats: [keyof Summary, ModelKey][] = [
    ['ready', 'mc.summary.ready'],
    ['missing', 'mc.summary.missing'],
    ['restart', 'mc.summary.restart'],
    ['total', 'mc.summary.total'],
  ]
  return (
    <div className={styles.overview}>
      <dl className={styles.stats} data-testid="model-summary">
        {stats.map(([kind, label]) =>
          kind === 'restart' && summary.restart === 0 ? null : (
            <div key={kind} className={styles.stat} data-kind={kind}>
              <dt>{mt(label)}</dt>
              <dd data-testid={`model-count-${kind}`}>{summary[kind]}</dd>
            </div>
          ),
        )}
      </dl>
      <div className={styles.overviewEnd}>
        {queue.running && (
          <>
            <p className={styles.queue} role="status" data-testid="model-queue">
              {mt('mc.queue.running', { i: queue.index + 1, n: queue.total, name: queue.label })}
            </p>
            <button type="button" className={`btn btn-ghost ${styles.queueLink}`} onClick={() => useJobs.getState().setDrawerOpen(true)}>
              {mt('mc.queue.show')}
            </button>
          </>
        )}
        <button type="button" className="btn btn-primary" onClick={onBulk} disabled={queue.running} data-testid="bulk-open">
          {mt('mc.bulk.open')}
        </button>
      </div>
    </div>
  )
}

const NOW: ModelKey[] = ['mc.avail.now.library', 'mc.avail.now.find', 'mc.avail.now.prompts', 'mc.avail.now.censor', 'mc.avail.now.colors', 'mc.avail.now.dataset']
const LATER: ModelKey[] = [
  'mc.avail.later.tagging',
  'mc.avail.later.similar',
  'mc.avail.later.aesthetic',
  'mc.avail.later.artist',
  'mc.avail.later.censor',
  'mc.avail.later.caption',
  'mc.avail.later.masks',
]

/** What works now and what downloads on first use; the "moved folder, all missing" answer. */
function Explainer() {
  const mt = useMT()
  return (
    <div className={styles.explain}>
      <p className={styles.lead}>{mt('mc.lead')}</p>
      <details className={styles.more} data-testid="model-availability">
        <summary>{mt('mc.avail.title')}</summary>
        <div className={styles.lists}>
          <ListBlock title="mc.avail.nowTitle" items={NOW} />
          <ListBlock title="mc.avail.laterTitle" items={LATER} />
        </div>
        <p className={styles.moreText}>{mt('mc.avail.restart')}</p>
      </details>
      <details className={styles.more} data-testid="model-moved">
        <summary>{mt('mc.moved.title')}</summary>
        <p className={styles.moreText}>{mt('mc.moved.body')}</p>
      </details>
    </div>
  )
}

function ListBlock({ title, items }: { title: ModelKey; items: ModelKey[] }) {
  const mt = useMT()
  return (
    <div>
      <h4 className={styles.listTitle}>{mt(title)}</h4>
      <ul className={styles.list}>
        {items.map((key) => (
          <li key={key}>{mt(key)}</li>
        ))}
      </ul>
    </div>
  )
}

const MIRRORS: { value: string; label: ModelKey; hint: ModelKey }[] = [
  { value: 'auto', label: 'mc.mirror.auto', hint: 'mc.mirror.hint.auto' },
  { value: 'hf-mirror', label: 'mc.mirror.hf', hint: 'mc.mirror.hint.hf' },
  { value: 'modelscope', label: 'mc.mirror.modelscope', hint: 'mc.mirror.hint.modelscope' },
]

/** One download source for every model (only Kaloscope's card can override it). */
function MirrorChoice() {
  const mt = useMT()
  const t = useT()
  const id = useId()
  const mirror = useMirror()
  const [saved, mark] = useSaved<'mirror'>()
  const current = mirror.data?.mirror ?? 'auto'
  const hint = MIRRORS.find((m) => m.value === current)?.hint ?? 'mc.mirror.hint.auto'
  const choose = async (value: string) => {
    if (await saveMirror(value)) mark('mirror')
  }
  return (
    <div className={styles.mirror} data-testid="model-mirror">
      <span id={id} className={styles.mirrorTitle}>
        {mt('mc.mirror.title')}
        <span className={styles.saved} role="status">
          {saved === 'mirror' ? t('settings.saved') : ''}
        </span>
      </span>
      <div className={styles.choices} role="radiogroup" aria-labelledby={id}>
        {MIRRORS.map((m) => (
          <label key={m.value} className={styles.choice} data-checked={m.value === current || undefined}>
            <input type="radio" name="model-mirror" value={m.value} checked={m.value === current} disabled={!mirror.isSuccess} onChange={() => void choose(m.value)} />
            {mt(m.label)}
          </label>
        ))}
      </div>
      <p className={styles.mirrorHint}>{mt(hint)}</p>
    </div>
  )
}

function CardGroup({ title, cards, lit, testId }: { title: ModelKey; cards: ModelCenterCard[]; lit: string | null; testId: string }) {
  const mt = useMT()
  if (!cards.length) return null
  return (
    <section className={styles.group} data-testid={testId}>
      <h3 className={styles.groupTitle}>{mt(title)}</h3>
      <div className={styles.grid}>
        {cards.map((card) => (
          <ModelCard key={card.id} card={card} focused={lit === card.id} />
        ))}
      </div>
    </section>
  )
}
