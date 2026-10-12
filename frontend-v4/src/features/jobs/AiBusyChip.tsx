import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { useClickOutside, useLayer } from '../../ui/layers'
import { clock, shortName, spoken, workName, type Holder, type Translate } from './aiBusy'
import styles from './AiBusyChip.module.css'
import { startAiBusy, useAiHolders } from './aiBusyPoll'
import { useJobs } from './jobs'

/**
 * Top bar: what is using the AI right now (only while something is), for how
 * long, and "!" when the app thinks it is stuck. Click for all of it. Mounted
 * in the top bar already, so this file never edits TopBar.
 */
export function AiBusyChip() {
  const t = useT()
  const holders = useAiHolders()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const visible = open && holders.length > 0
  useLayer(visible, () => setOpen(false))
  useClickOutside(ref, visible, () => setOpen(false))
  useEffect(() => startAiBusy(), [])
  // The AI went idle with the list open: it must not pop open again next time.
  const idle = holders.length === 0
  useEffect(() => {
    if (idle) setOpen(false)
  }, [idle])

  const lead = holders[0]
  if (!lead) return null
  const stuck = holders.some((h) => h.stuck)
  const list = holders.map((h) => `${workName(h, t)} (${clock(h.seconds)})`).join('; ')

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={styles.chip}
        data-stuck={stuck || undefined}
        aria-expanded={visible}
        title={t('signals.chip.title', { list })}
        onClick={() => setOpen(!open)}
        data-testid="ai-busy"
      >
        <span className={styles.mark} aria-hidden>
          AI
        </span>
        <span className={styles.name}>{shortName(lead, t)}</span>
        {lead.device === 'gpu' && <span className={styles.device}>GPU</span>}
        <span className={`${styles.clock} mono`}>{lead.atLeast ? `≥${clock(lead.seconds)}` : clock(lead.seconds)}</span>
        {holders.length > 1 && <span className={`${styles.more} mono`}>+{holders.length - 1}</span>}
        {stuck && (
          <span className={styles.stuck} title={t('signals.chip.stuck')} aria-label={t('signals.chip.stuck')}>
            !
          </span>
        )}
      </button>
      {visible && <HoldersPanel holders={holders} t={t} onLeave={() => setOpen(false)} />}
    </div>
  )
}

function HoldersPanel({ holders, t, onLeave }: { holders: Holder[]; t: Translate; onLeave: () => void }) {
  const jobs = useJobs((s) => s.jobs)
  const inDrawer = holders.some((h) => h.jobId !== null && jobs.some((j) => j.id === h.jobId))
  return (
    <section className={styles.panel} aria-label={t('signals.panel.title')} data-testid="ai-busy-panel">
      <h2 className={styles.title}>{t('signals.panel.title')}</h2>
      <ul className={styles.list}>
        {holders.map((h) => (
          <HolderRow key={h.key} holder={h} t={t} adopted={jobs.find((j) => j.id === h.jobId)?.adopted ?? h.jobId === null} />
        ))}
      </ul>
      <p className={styles.foot}>{t('signals.panel.oneAtATime')}</p>
      {inDrawer && (
        <button
          type="button"
          className="btn"
          onClick={() => {
            onLeave()
            useJobs.getState().setDrawerOpen(true)
          }}
        >
          {t('signals.panel.openJobs')}
        </button>
      )}
    </section>
  )
}

/** Work already running when the page opened is timed from then: under a minute of that says only when it began. */
function elapsedText(h: Holder, time: string, t: Translate): string {
  if (!h.atLeast) return t('signals.panel.elapsed', { time })
  return h.seconds < 60 ? t('signals.panel.before') : t('signals.panel.elapsedAtLeast', { time })
}

function HolderRow({ holder: h, t, adopted }: { holder: Holder; t: Translate; adopted: boolean }) {
  const time = spoken(h.seconds, t)
  const facts = [
    h.device === 'gpu' ? t('signals.panel.gpu') : h.device === 'cpu' ? t('signals.panel.cpu') : null,
    h.progress ? t('signals.panel.progress', { current: h.progress.current, total: h.progress.total }) : null,
    h.vramMb ? t('signals.panel.vram', { n: h.vramMb }) : null,
    h.key.startsWith('run:') && adopted ? t('jobs.startedElsewhere') : null,
  ].filter((x): x is string => x !== null)
  return (
    <li className={styles.row} data-stuck={h.stuck || undefined} data-testid="ai-busy-row">
      <div className={styles.rowHead}>
        <strong className={styles.rowName}>{workName(h, t)}</strong>
        <span className={`${styles.clock} mono`}>{clock(h.seconds)}</span>
      </div>
      <p className={styles.note}>{elapsedText(h, time, t)}</p>
      {facts.length > 0 && <p className={styles.note}>{facts.join(' · ')}</p>}
      {h.stuck && <p className={styles.warn}>{t('signals.panel.stuck', { time })}</p>}
    </li>
  )
}
