import { useT } from '../../i18n'
import { decided, upNow, type SessionView, type SortAction } from './sortSession'
import styles from './SortStage.module.css'
import { useSort } from './sortStore'
import { Picture, Stage, useLit } from './StageParts'

/** Keep / reject in progress: one picture, and the tally lit by each decision. */
export function CullStage({ view }: { view: SessionView }) {
  const t = useT()
  const lit = useLit((last) => (last.kind === 'keep' || last.kind === 'reject' || last.kind === 'skip' ? last.kind : null))
  const now = upNow(view)
  const { keep, reject } = decided(view)
  const press = (action: SortAction) => useSort.getState().press(action)

  const keys = (
    <div className={styles.choices}>
      <button type="button" className={styles.choice} data-side="reject" data-lit={lit === 'reject' || undefined} onClick={() => press({ kind: 'reject' })} data-testid="sort-reject">
        <kbd className={styles.cap}>←</kbd>
        <span className={styles.slotName}>{t('sort.cull.reject')}</span>
        <span className={`${styles.keysAlso} mono`}>A X</span>
        <span className={`${styles.slotCount} mono`} data-testid="sort-rejected">
          {reject.length}
        </span>
      </button>
      <button type="button" className={styles.choice} data-lit={lit === 'skip' || undefined} onClick={() => press({ kind: 'skip' })} data-testid="sort-skip">
        <kbd className={styles.cap}>{t('sort.spaceKey')}</kbd>
        <span className={styles.slotName}>{t('sort.skip')}</span>
        <span className={`${styles.keysAlso} mono`}>W S</span>
        <span className={`${styles.slotCount} mono`}>{view.skipped}</span>
      </button>
      <button type="button" className={styles.choice} data-side="keep" data-lit={lit === 'keep' || undefined} onClick={() => press({ kind: 'keep' })} data-testid="sort-keep">
        <kbd className={styles.cap}>→</kbd>
        <span className={styles.slotName}>{t('sort.cull.keep')}</span>
        <span className={`${styles.keysAlso} mono`}>D K</span>
        <span className={`${styles.slotCount} mono`} data-testid="sort-kept">
          {keep.length}
        </span>
      </button>
    </div>
  )
  return (
    <Stage view={view} image={now?.image ?? null} infoId={now?.id ?? null} keys={keys}>
      {now && <Picture key={now.id} id={now.id} name={now.image?.filename ?? ''} />}
    </Stage>
  )
}
