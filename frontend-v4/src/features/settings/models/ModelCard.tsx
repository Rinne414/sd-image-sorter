import { useId, useState } from 'react'
import { startInstall, type InstallTarget } from '../../jobs/installJob'
import { taggerInfo } from '../../tagging/taggers'
import { restartAndContinue, useModelQueue } from './bulkRun'
import { GatedNote, OtherTaggers, PlanLine, SourcePicker, useRunningInstall, VariantPicker } from './CardParts'
import styles from './ModelCard.module.css'
import { ManualInstall } from './ManualInstall'
import { cardStatus, kindKey, messageKey, nameOf, preferredVariant, purposeKey, sizeHint, type CardStatus } from './modelCards'
import { useMT, type ModelKey } from './modelText'
import type { ModelCenterCard } from './types'

const STATUS: Record<CardStatus, ModelKey> = { ready: 'mc.status.ready', missing: 'mc.status.missing', restart: 'mc.status.restart' }

/** One model: what it is for, its size and state, its version and source, and how to get it ready. */
export function ModelCard({ card, focused }: { card: ModelCenterCard; focused: boolean }) {
  const mt = useMT()
  const titleId = useId()
  const status = cardStatus(card)
  const [variant, setVariant] = useState(preferredVariant(card))
  const [source, setSource] = useState('auto')
  const purpose = purposeKey(card.id)
  // the tagger card lists its downloaded versions itself; the backend's count would repeat it
  const message = card.message_key === 'models.wd14.readyCount' ? null : messageKey(card)
  const name = nameOf(card, mt)
  const target: InstallTarget = { card: card.id, variant, label: name, ...(source !== 'auto' ? { source } : {}) }

  return (
    <article
      className={styles.card}
      data-card={card.id}
      data-status={status}
      data-focus={focused || undefined}
      data-testid={`model-card-${card.id}`}
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <header className={styles.head}>
        <div className={styles.headText}>
          <p className={styles.kind}>
            {mt(kindKey(card.group_key))}
            {card.recommended && <span className={styles.rec}>{mt('mc.recommended')}</span>}
          </p>
          <h4 id={titleId} className={styles.name}>
            {name}
          </h4>
        </div>
        <span className={styles.status} data-status={status} data-testid="model-status">
          {mt(STATUS[status])}
        </span>
      </header>
      {purpose && <p className={styles.purpose}>{mt(purpose)}</p>}
      <Facts card={card} variant={variant} />
      {message && <p className={styles.message}>{mt(message, card.message_params)}</p>}
      <VariantPicker card={card} variant={variant} onChange={setVariant} />
      {card.id === 'wd14' && <OtherTaggers card={card} />}
      {card.id === 'wd14' && <p className={styles.gpu}>{mt('mc.gpu')}</p>}
      <SourcePicker card={card} source={source} onChange={setSource} />
      {card.gated_download && <GatedNote card={card} />}
      {status === 'missing' && <PlanLine id={card.id} />}
      <Actions card={card} status={status} target={target} />
      <ManualInstall card={card} />
    </article>
  )
}

/** Size (of the chosen version) and which versions are on disk. */
function Facts({ card, variant }: { card: ModelCenterCard; variant: string | null }) {
  const mt = useMT()
  const hint = sizeHint(card, variant)
  const size = card.id === 'tipo' ? mt('mc.size.tipo') : hint ? mt('mc.size', { size: hint }) : null
  const installed = (card.installed_variants ?? []).map((v) => taggerInfo(v).label)
  if (!size && !installed.length) return null
  return (
    <p className={styles.facts} data-testid="model-facts">
      {size}
      {size && installed.length > 0 && ' · '}
      {installed.length > 0 && mt('mc.installed', { list: installed.join(mt('mc.listSep')) })}
    </p>
  )
}

function Actions({ card, status, target }: { card: ModelCenterCard; status: CardStatus; target: InstallTarget }) {
  const mt = useMT()
  const running = useRunningInstall()
  const queue = useModelQueue((s) => s.running)
  const [restarting, setRestarting] = useState(false)
  const mine = running?.ctx.modelId === card.id ? running : undefined

  if (status === 'restart') {
    const go = async () => {
      setRestarting(true)
      await restartAndContinue([target])
      setRestarting(false)
    }
    return (
      <div className={styles.actions}>
        <button type="button" className="btn btn-primary" onClick={() => void go()} disabled={restarting} data-testid="model-restart">
          {mt('mc.restartContinue')}
        </button>
      </div>
    )
  }
  if (card.download_supported === false && status !== 'ready') return <p className={styles.note}>{mt('mc.noAuto')}</p>

  const have = status === 'ready' && (!target.variant || !!card.installed_variants?.includes(target.variant))
  const pct = mine && mine.progress.total > 0 ? Math.round((mine.progress.current / mine.progress.total) * 100) : null
  const label = mine ? (pct === null ? mt('mc.downloading') : mt('mc.downloadingPct', { pct })) : mt(have ? 'mc.recheck' : 'mc.prepare')
  const other = mine ? undefined : running
  const blockedBy = other ? nameOf({ id: other.ctx.modelId ?? '', name: other.label ?? undefined }, mt) : null
  return (
    <div className={styles.actions}>
      <button
        type="button"
        className={have ? 'btn' : 'btn btn-primary'}
        onClick={() => void startInstall(target)}
        disabled={!!running || queue}
        data-testid="model-prepare"
      >
        {label}
      </button>
      {blockedBy && <span className={styles.wait}>{mt('mc.waitOther', { name: blockedBy })}</span>}
    </div>
  )
}
