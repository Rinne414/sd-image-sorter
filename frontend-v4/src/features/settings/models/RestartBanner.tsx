import { useState } from 'react'
import { useResume, clearResume } from '../../jobs/installResume'
import { continueSaved, restartAndContinue, useModelQueue } from './bulkRun'
import styles from './ModelCenter.module.css'
import { cardStatus, nameOf, preferredVariant } from './modelCards'
import { useMT } from './modelText'
import type { ModelCenterCard } from './types'

/**
 * Above the cards: "restart needed" (a card waits on it, or a download run
 * paused for it) with "Restart now and continue", or the downloads a closed
 * tab left unfinished with "Continue downloading". Hidden while a run is going.
 */
export function RestartBanner({ cards }: { cards: readonly ModelCenterCard[] }) {
  const mt = useMT()
  const list = useResume((s) => s.list)
  const running = useModelQueue((s) => s.running)
  const hidden = useModelQueue((s) => s.bannerHidden)
  const [restarting, setRestarting] = useState(false)
  if (running) return null

  const waiting = cards.filter((c) => cardStatus(c) === 'restart')
  const pending = list?.items ?? []
  const needsRestart = waiting.length > 0 || list?.restart === true

  if (needsRestart && !hidden) {
    const first = waiting.map((c) => ({ card: c.id, variant: preferredVariant(c), label: nameOf(c, mt) }))
    const after = pending.filter((p) => !first.some((f) => f.card === p.card)).length + first.length
    const go = async () => {
      setRestarting(true)
      await restartAndContinue(first)
      setRestarting(false)
    }
    return (
      <div className={styles.banner} role="status" data-testid="model-banner" data-kind="restart">
        <div className={styles.bannerText}>
          <p className={styles.bannerTitle}>{mt('mc.banner.restartTitle')}</p>
          <p className={styles.bannerBody}>
            {mt('mc.banner.restartBody', { n: after })}
          </p>
        </div>
        <div className={styles.bannerActions}>
          <button type="button" className="btn btn-primary" onClick={() => void go()} disabled={restarting} data-testid="banner-restart">
            {mt('mc.restartContinue')}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => useModelQueue.setState({ bannerHidden: true })}>
            {mt('mc.banner.later')}
          </button>
        </div>
      </div>
    )
  }
  if (needsRestart || !pending.length) return null
  return (
    <div className={styles.banner} role="status" data-testid="model-banner" data-kind="pending">
      <div className={styles.bannerText}>
        <p className={styles.bannerTitle}>{mt('mc.banner.pendingTitle', { n: pending.length })}</p>
        <p className={styles.bannerBody}>{mt('mc.banner.pendingBody', { names: pending.map((p) => p.label).join(mt('mc.listSep')) })}</p>
      </div>
      <div className={styles.bannerActions}>
        <button type="button" className="btn btn-primary" onClick={continueSaved} data-testid="banner-continue">
          {mt('mc.banner.continue')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={clearResume}>
          {mt('mc.banner.drop')}
        </button>
      </div>
    </div>
  )
}
