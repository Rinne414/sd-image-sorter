import { thumbnailUrl } from '../../api/client'
import { useFavorites, useToggleFavorite } from '../../api/queries'
import { useT, type MessageKey } from '../../i18n'
import { useApp } from '../../state/store'
import { factText } from './DuelStage'
import { facts } from './sortModes'
import { decided, type SessionView } from './sortSession'
import styles from './SortPage.module.css'
import { SummaryFrame } from './SortSummary'

// The finished A/B showdown and keep/reject: nothing moved, so the summary is
// where the result is used — favourite it, or pick it in the library, where
// the selection bar moves, batches, re-tags or trashes it.

/** Thumbnails shown for a group before "+N". */
const GROUP_THUMBS = 12

/** Pick these in the library and go there, the first one shown on the card. */
function pickInLibrary(ids: number[]): void {
  const s = useApp.getState()
  s.setSelection(ids)
  if (ids[0] !== undefined) s.inspect(ids[0])
  s.setPage('library')
}

/** Favourite (or unfavourite) these; says which it will do. */
function FavoriteButton({ ids, label, testId }: { ids: number[]; label: MessageKey; testId: string }) {
  const t = useT()
  const favorites = useFavorites()
  const toggle = useToggleFavorite()
  const favIds = favorites.data?.ids
  const all = ids.length > 0 && !!favIds && ids.every((id) => favIds.has(id))
  return (
    <button type="button" className="btn" aria-pressed={all} onClick={() => toggle.mutate({ ids, favorited: !all })} disabled={ids.length === 0 || toggle.isPending} data-testid={testId}>
      {all ? t('sort.done.favorited') : t(label)}
    </button>
  )
}

export function DuelSummary({ view }: { view: SessionView }) {
  const t = useT()
  const winner = view.winner
  const body = t('sort.done.bracketBody', { total: view.total, rounds: Math.max(0, view.total - 1), skipped: view.skipped })
  return (
    <SummaryFrame view={view} title={t('sort.done.bracketTitle')} body={body}>
      {winner ? (
        <div className={styles.winner} data-testid="sort-winner" data-id={winner.id}>
          <img className={styles.winnerImage} src={thumbnailUrl(winner.id, 512)} alt={winner.filename} draggable={false} />
          <div className={styles.winnerInfo}>
            <span className={styles.section}>{t('sort.done.winner')}</span>
            <strong className={styles.winnerName} title={winner.path}>
              {winner.filename}
            </strong>
            <span className={`${styles.optionHint} mono`}>{facts(winner).map(([key, value]) => factText(t, key, value)).join(' · ')}</span>
            <span className={styles.groupActions}>
              <FavoriteButton ids={[winner.id]} label="sort.done.favorite" testId="sort-winner-favorite" />
              <button type="button" className="btn" onClick={() => pickInLibrary([winner.id])} data-testid="sort-winner-pick">
                {t('sort.done.selectInLibrary')}
              </button>
            </span>
          </div>
        </div>
      ) : (
        <p className={styles.warn}>{t('sort.done.noWinner')}</p>
      )}
    </SummaryFrame>
  )
}

function Group({ ids, title, favorite, testId }: { ids: number[]; title: string; favorite: boolean; testId: string }) {
  const t = useT()
  const more = ids.length - GROUP_THUMBS
  return (
    <li className={styles.group2} data-testid={testId} data-count={ids.length}>
      <div className={styles.groupHead}>
        <strong>{title}</strong>
        <span className={styles.groupActions}>
          {favorite && <FavoriteButton ids={ids} label="sort.done.favoriteAll" testId={`${testId}-favorite`} />}
          <button type="button" className="btn" onClick={() => pickInLibrary(ids)} disabled={ids.length === 0} data-testid={`${testId}-pick`}>
            {t('sort.done.selectInLibrary')}
          </button>
        </span>
      </div>
      {ids.length === 0 ? (
        <p className={styles.note}>{t('sort.done.none')}</p>
      ) : (
        <div className={styles.thumbs}>
          {ids.slice(0, GROUP_THUMBS).map((id) => (
            <img key={id} src={thumbnailUrl(id, 256)} alt="" loading="lazy" decoding="async" draggable={false} />
          ))}
          {more > 0 && <span className={`${styles.more} mono`}>+{more}</span>}
        </div>
      )}
    </li>
  )
}

export function CullSummary({ view }: { view: SessionView }) {
  const t = useT()
  const { keep, reject } = decided(view)
  const body = t('sort.done.cullBody', { total: view.total, kept: keep.length, rejected: reject.length, skipped: view.skipped })
  return (
    <SummaryFrame view={view} title={t('sort.done.cullTitle')} body={body}>
      <ul className={styles.doneList}>
        <Group ids={keep} title={t('sort.done.kept', { n: keep.length })} favorite testId="sort-kept-group" />
        <Group ids={reject} title={t('sort.done.rejected', { n: reject.length })} favorite={false} testId="sort-rejected-group" />
      </ul>
      <p className={styles.note}>{t('sort.done.selectHint')}</p>
    </SummaryFrame>
  )
}
