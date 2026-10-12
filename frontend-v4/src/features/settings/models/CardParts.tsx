import { useId } from 'react'
import { useT } from '../../../i18n'
import { startInstall } from '../../jobs/installJob'
import { useJobs, type Job } from '../../jobs/jobs'
import { isFinished } from '../../jobs/progress'
import { taggerInfo } from '../../tagging/taggers'
import { useModelQueue } from './bulkRun'
import styles from './ModelCard.module.css'
import { safeUrl, splitTaggers } from './modelCards'
import { useModelPlan } from './modelsApi'
import { useMT, type ModelKey } from './modelText'
import type { ModelCenterCard } from './types'

// The optional parts of a model card: the version picker, the other taggers
// the tagger card can fetch, the download source, what preparing installs,
// and the permission a gated model needs.

const has = (card: ModelCenterCard, variant: string) => !!card.installed_variants?.includes(variant)

const isRunningInstall = (j: Job) => j.kind === 'install' && !isFinished(j.progress.status)

/** The download running now (this page or another), if any. */
export function useRunningInstall(): Job | undefined {
  return useJobs((s) => s.jobs.find(isRunningInstall))
}

/** WD14's versions, the recommended one chosen first; what the chosen one is like under it. */
export function VariantPicker({ card, variant, onChange }: { card: ModelCenterCard; variant: string | null; onChange: (v: string) => void }) {
  const mt = useMT()
  const t = useT()
  const id = useId()
  const { family } = splitTaggers(card)
  if (!family.length || !variant) return null
  return (
    <>
      <div className={styles.field}>
        <label htmlFor={id}>{mt('mc.variant')}</label>
        <select id={id} value={variant} onChange={(e) => onChange(e.target.value)} data-testid="model-variant">
          {family.map((v) => {
            const info = taggerInfo(v)
            const size = info.sizeHint ? ` · ${mt('mc.size', { size: info.sizeHint })}` : ''
            return (
              <option key={v} value={v}>
                {info.label}
                {size}
                {has(card, v) ? mt('mc.variant.have') : ''}
              </option>
            )
          })}
        </select>
      </div>
      <p className={styles.note}>{t(taggerInfo(variant).note)}</p>
    </>
  )
}

/** Camie and PixAI come through the tagger card too: each with its size, what it is like, and a download. */
export function OtherTaggers({ card }: { card: ModelCenterCard }) {
  const mt = useMT()
  const t = useT()
  const running = useRunningInstall()
  const queue = useModelQueue((s) => s.running)
  const { others } = splitTaggers(card)
  if (!others.length) return null
  return (
    <section className={styles.others} data-testid="other-taggers">
      <h5 className={styles.othersTitle}>{mt('mc.otherTaggers.title')}</h5>
      <ul className={styles.otherList}>
        {others.map((v) => {
          const info = taggerInfo(v)
          const downloaded = has(card, v)
          return (
            <li key={v} className={styles.other} data-variant={v}>
              <span className={styles.otherName}>
                {info.label}
                {info.familyPick && <span className={styles.rec}>{t(info.familyPick)}</span>}
                <span className={styles.otherMeta}>
                  {info.sizeHint ? `${mt('mc.size', { size: info.sizeHint })} · ` : ''}
                  {mt(downloaded ? 'mc.otherTaggers.have' : 'mc.otherTaggers.missing')}
                </span>
              </span>
              {!downloaded && (
                <button
                  type="button"
                  className={`btn ${styles.small}`}
                  disabled={!!running || queue}
                  onClick={() => void startInstall({ card: card.id, variant: v, label: info.label })}
                >
                  {running?.ctx.modelId === card.id && running.label === info.label ? mt('mc.downloading') : mt('mc.otherTaggers.get')}
                </button>
              )}
              <p className={styles.otherNote}>{t(info.note)}</p>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

const SOURCE: Record<string, ModelKey> = { auto: 'mc.source.auto', huggingface: 'mc.source.huggingface', modelscope: 'mc.source.modelscope' }

/** Only a card that really can download from elsewhere (Kaloscope) has a choice; SAM 3 says where it comes from. */
export function SourcePicker({ card, source, onChange }: { card: ModelCenterCard; source: string; onChange: (s: string) => void }) {
  const mt = useMT()
  const id = useId()
  if (card.id === 'sam3') return <p className={styles.note}>{mt('mc.source.sam3')}</p>
  const sources = (card.sources ?? []).filter((s) => s in SOURCE)
  if (sources.length < 2) return null
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{mt('mc.source')}</label>
      <select id={id} value={source} onChange={(e) => onChange(e.target.value)} data-testid="model-source">
        {sources.map((s) => (
          <option key={s} value={s}>
            {mt(SOURCE[s] ?? 'mc.source.auto')}
          </option>
        ))}
      </select>
    </div>
  )
}

/** What getting a missing model ready involves (packages, a restart), when the backend knows. */
export function PlanLine({ id }: { id: string }) {
  const mt = useMT()
  const plan = useModelPlan(id, true)
  const p = plan.data
  if (!p || p.restart_likely === null) return null
  const n = p.packages.length
  const key: ModelKey = n === 0 ? 'mc.plan.plain' : p.restart_likely ? 'mc.plan.restart' : 'mc.plan.noRestart'
  return (
    <p className={styles.note} data-testid="model-plan">
      {mt(key, { n })}
    </p>
  )
}

/** A gated model: accept its terms on Hugging Face first. */
export function GatedNote({ card }: { card: ModelCenterCard }) {
  const mt = useMT()
  const url = safeUrl(card.external_links?.find((l) => safeUrl(l.url))?.url)
  return (
    <p className={styles.note}>
      {mt('mc.gated')}{' '}
      {url && (
        <a className={styles.link} href={url} target="_blank" rel="noopener noreferrer" data-testid="model-auth-link">
          {mt('mc.authLink')} ↗
        </a>
      )}
    </p>
  )
}
