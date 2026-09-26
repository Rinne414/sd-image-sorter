import { useId, useMemo, useState } from 'react'
import { thumbnailUrl } from '../../api/client'
import type { ImageSummary } from '../../api/types'
import { useT } from '../../i18n'
import { quickCensor } from '../censor/quickCensor'
import { useSelectionDialog } from '../selection/dialogs'
import { sendToTool } from '../tools/handoff'
import { useSimilarDialogs } from './dialogs'
import styles from './Duplicates.module.css'
import { PAIR_DEFAULT, PAIR_MAX, PAIR_MIN, warnsLow, type Pair, type PairImage, type PairProblem } from './pairs'
import { useSimilarPairs } from './similarApi'

// "相似的一对" in the duplicates dialog: V3.5's pair finder. Pick how alike
// (50-99 %), find, and look at the pairs most alike first; each image opens
// full size, goes to the Reader, to censoring or to Prompt Lab (as in V3.5),
// or to the Recycle Bin through the usual confirm.

interface Props {
  /** Open an image full size, the pair's two in the strip. */
  onView: (rows: ImageSummary[], id: number) => void
  /** Switch the dialog to the grouped cleanup. */
  onGroups: () => void
}

export function PairsView({ onView, onGroups }: Props) {
  const t = useT()
  const id = useId()
  const [value, setValue] = useState(PAIR_DEFAULT)
  const [asked, setAsked] = useState<number | null>(null)
  const pairs = useSimilarPairs(asked)
  const pages = pairs.data?.pages ?? []
  const list = pages.flatMap((p) => p.pairs)
  const rows = useMemo(() => new Map(pages.flatMap((p) => p.rows).map((r) => [r.id, r])), [pages])
  const first = pages[0]
  const shown = `${Math.round(value * 100)}%`

  return (
    <div className={styles.pairsView}>
      <div className={styles.scan}>
        <p className={styles.muted}>{t('sim.pairs.hint')}</p>
        <label className={styles.pairThreshold} htmlFor={id}>
          {t('sim.threshold')}
          <input
            id={id}
            type="range"
            min={PAIR_MIN}
            max={PAIR_MAX}
            step={0.01}
            value={value}
            onChange={(e) => setValue(Number(e.target.value))}
            aria-valuetext={shown}
            data-testid="pairs-threshold"
          />
          <span className="mono">{shown}</span>
        </label>
        <button type="button" className="btn" onClick={() => (asked === value ? void pairs.refetch() : setAsked(value))} data-testid="pairs-find">
          {t('sim.pairs.find')}
        </button>
        {warnsLow(value) && (
          <p className={styles.warn} role="status" data-testid="pairs-warn">
            {t('sim.pairs.warnLow')}
          </p>
        )}
      </div>
      {pairs.isFetching && !pairs.isFetchingNextPage && <p className={styles.muted}>{t('sim.dup.loading')}</p>}
      {pairs.isError && <p className={styles.error}>{t('sim.pairs.failed', { reason: pairs.error.message })}</p>}
      {first?.problem && <Problem problem={first.problem} onGroups={onGroups} />}
      {first && !first.problem && !pairs.isFetching && list.length === 0 && <p className={styles.muted}>{t('sim.pairs.none')}</p>}
      {list.length > 0 && <p className={styles.muted}>{t('sim.pairs.count', { n: first?.total ?? list.length })}</p>}
      <ol className={styles.pairs} data-testid="similar-pairs">
        {list.map((p) => (
          <PairRow key={`${p.a.id}-${p.b.id}`} pair={p} onView={(which) => onView([p.a.id, p.b.id].flatMap((x) => rows.get(x) ?? []), which)} />
        ))}
      </ol>
      {pairs.hasNextPage && (
        <button type="button" className="btn btn-ghost" onClick={() => void pairs.fetchNextPage()} disabled={pairs.isFetchingNextPage}>
          {pairs.isFetchingNextPage ? t('sim.dup.loading') : t('sim.pairs.more', { n: Math.max(0, (first?.total ?? 0) - list.length) })}
        </button>
      )}
    </div>
  )
}

function Problem({ problem, onGroups }: { problem: PairProblem; onGroups: () => void }) {
  const t = useT()
  if (problem.kind === 'too-few') return <p className={styles.muted}>{t('sim.pairs.tooFew', { n: problem.minimum })}</p>
  return (
    <p className={styles.muted}>
      {t('sim.pairs.tooMany', { n: problem.embedded, max: problem.max })}
      <button type="button" className={styles.link} onClick={onGroups}>
        {t('sim.pairs.toGroups')}
      </button>
    </p>
  )
}

function PairRow({ pair, onView }: { pair: Pair; onView: (id: number) => void }) {
  return (
    <li className={styles.pair} data-testid="similar-pair" data-ids={`${pair.a.id},${pair.b.id}`}>
      <PairSide image={pair.a} onView={() => onView(pair.a.id)} />
      <span className={`${styles.pairScore} mono`}>{(Math.floor(pair.similarity * 1000) / 10).toFixed(1)}%</span>
      <PairSide image={pair.b} onView={() => onView(pair.b.id)} />
    </li>
  )
}

/** Leave the dialog for a page that works on this image. */
const leaveFor = (go: () => void) => {
  useSimilarDialogs.getState().setDuplicates(false)
  go()
}

function PairSide({ image, onView }: { image: PairImage; onView: () => void }) {
  const t = useT()
  const ids = [image.id]
  return (
    <div className={styles.pairSide}>
      <button type="button" className={styles.thumb} onClick={onView} aria-label={t('sim.dup.view')} title={t('sim.dup.view')} data-testid="pair-view" data-id={image.id}>
        <img src={thumbnailUrl(image.id, 256)} alt="" loading="lazy" draggable={false} />
      </button>
      <span className={styles.filename} title={image.filename}>
        {image.filename}
      </span>
      <span className={styles.pairActions}>
        <button type="button" className={styles.link} onClick={() => leaveFor(() => sendToTool('reader', ids))}>
          {t('tools.reader')}
        </button>
        <button type="button" className={styles.link} onClick={() => leaveFor(() => void quickCensor(ids))}>
          {t('sel.censor')}
        </button>
        <button type="button" className={styles.link} onClick={() => leaveFor(() => sendToTool('promptlab', ids))}>
          {t('tools.promptlab')}
        </button>
        <button
          type="button"
          className={`${styles.link} ${styles.danger}`}
          onClick={() => useSelectionDialog.getState().showFor('trash', ids, 1)}
          data-testid="pair-trash"
          data-id={image.id}
        >
          {t('sel.trash')}
        </button>
      </span>
    </div>
  )
}
