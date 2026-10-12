import { useId, useRef, useState } from 'react'
import { useT } from '../../../i18n'
import { Dialog } from '../../../ui/Dialog'
import styles from './BulkDialog.module.css'
import { allPicks, canPick, downloadSize, initialPicks, pickedBytes, pickedTargets, recommendedPicks } from './bulkPlan'
import { downloadModels } from './bulkRun'
import { nameOf, safeUrl } from './modelCards'
import { useBulkBundle } from './modelsApi'
import { isModelKey, useMT } from './modelText'
import type { BulkItem } from './types'

/**
 * "Download models…": the recommended models ticked, the gated one with its
 * permission page and not ticked, the total, then one download after another
 * in the Jobs drawer.
 */
export function BulkDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const mt = useMT()
  const bundle = useBulkBundle()
  const items = bundle.data?.items ?? []
  const [chosen, setChosen] = useState<Set<string> | null>(null)
  const picks = chosen ?? initialPicks(items)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const count = items.filter((i) => picks.has(i.id) && canPick(i)).length
  const size = downloadSize(pickedBytes(items, picks))

  const toggle = (id: string, on: boolean) => {
    const next = new Set(picks)
    if (on) next.add(id)
    else next.delete(id)
    setChosen(next)
  }
  const start = () => {
    const targets = pickedTargets(items, picks, (id) => nameOf({ id, name: items.find((i) => i.id === id)?.label }, mt))
    onClose()
    void downloadModels(targets)
  }

  const footer = (
    <>
      <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn btn-primary" onClick={start} disabled={count === 0} data-testid="bulk-start">
        {count ? mt('mc.bulk.start', { n: count, size }) : mt('mc.bulk.startNone')}
      </button>
    </>
  )

  return (
    <Dialog title={mt('mc.bulk.title')} onClose={onClose} footer={footer} testId="bulk-dialog" initialFocus={cancelRef} wide>
      <p className={styles.intro}>{mt('mc.bulk.intro')}</p>
      {bundle.isPending && <p className={styles.note}>{mt('mc.bulk.loading')}</p>}
      {bundle.isError && <p className={styles.note}>{mt('mc.bulk.failed', { reason: bundle.error.message })}</p>}
      {bundle.isSuccess && (
        <>
          <div className={styles.tools}>
            <button type="button" className={`btn ${styles.small}`} onClick={() => setChosen(recommendedPicks(items))}>
              {mt('mc.bulk.recommended')}
            </button>
            <button type="button" className={`btn ${styles.small}`} onClick={() => setChosen(allPicks(items))}>
              {mt('mc.bulk.all')}
            </button>
            <button type="button" className={`btn ${styles.small}`} onClick={() => setChosen(new Set())}>
              {mt('mc.bulk.none')}
            </button>
          </div>
          <ul className={styles.list}>
            {items.map((item) => (
              <BulkRow key={item.id} item={item} picked={picks.has(item.id)} onToggle={(on) => toggle(item.id, on)} />
            ))}
          </ul>
          <p className={styles.summary} role="status" data-testid="bulk-summary">
            {items.some(canPick) ? mt('mc.bulk.summary', { n: count, size }) : mt('mc.bulk.allReady')}
          </p>
          <p className={styles.note}>{mt('mc.bulk.estimate')}</p>
          <Skipped ids={(bundle.data.excluded ?? []).map((e) => e.id)} />
        </>
      )}
    </Dialog>
  )
}

function BulkRow({ item, picked, onToggle }: { item: BulkItem; picked: boolean; onToggle: (on: boolean) => void }) {
  const mt = useMT()
  const id = useId()
  const pickable = canPick(item)
  const feature = `mc.bulk.feature.${item.feature_key ?? ''}`
  const auth = item.requires_auth ? safeUrl(item.auth_url ?? undefined) : null
  const meta = [
    isModelKey(feature) ? mt(feature) : null,
    item.restart_after_install && pickable ? mt('mc.bulk.restartAfter') : null,
    item.requires_auth ? mt('mc.bulk.auth') : null,
  ].filter(Boolean)
  return (
    <li className={styles.row} data-ready={!pickable || undefined} data-testid={`bulk-item-${item.id}`}>
      <input id={id} type="checkbox" checked={pickable && picked} disabled={!pickable} onChange={(e) => onToggle(e.target.checked)} />
      <label htmlFor={id} className={styles.name}>
        {nameOf({ id: item.id, name: item.label }, mt)}
        {item.recommended && <span className={styles.rec}>{mt('mc.recommended')}</span>}
      </label>
      <span className={styles.meta}>
        {meta.join(' · ')}
        {auth && (
          <>
            {' · '}
            <a className={styles.link} href={auth} target="_blank" rel="noopener noreferrer" data-testid="bulk-auth-link">
              {mt('mc.authLink')} ↗
            </a>
          </>
        )}
      </span>
      <span className={`${styles.size} mono`}>
        {item.status === 'ready' ? mt('mc.bulk.ready') : mt('mc.size', { size: downloadSize(item.size_bytes) })}
      </span>
    </li>
  )
}

/** The models kept out of "download all", each with a plain reason. */
function Skipped({ ids }: { ids: string[] }) {
  const mt = useMT()
  const lines = ids.flatMap((id) => {
    const key = `mc.bulk.skip.${id}`
    return isModelKey(key) ? [mt(key)] : [nameOf({ id }, mt)]
  })
  if (!lines.length) return null
  return (
    <>
      <p className={styles.note}>{mt('mc.bulk.skipped')}</p>
      <ul className={styles.skipped}>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </>
  )
}
