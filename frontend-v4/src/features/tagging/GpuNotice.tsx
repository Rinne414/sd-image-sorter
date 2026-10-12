import { useT } from '../../i18n'
import { spoken, tagStartPlan, workName, type Holder, type TagStartPlan, type Translate } from '../jobs/aiBusy'
import { useAiBusy, useAiHolders } from '../jobs/aiBusyPoll'
import { useJobs } from '../jobs/jobs'
import { isFinished } from '../jobs/progress'
import styles from './TagDialog.module.css'

/** What starting a tagging run now does, from what holds the AI and what tagging waits already. */
export function useTagStartPlan(): TagStartPlan {
  const holders = useAiHolders()
  const queued = useAiBusy((s) => s.tagQueued)
  const ours = useJobs((s) => s.jobs.some((j) => (j.kind === 'tag' || j.kind === 'smarttag') && !isFinished(j.progress.status)))
  return tagStartPlan(holders, ours || queued > 0)
}

/** How long it has run; work already running when the page opened is timed from then (under a minute of that says nothing). */
function runningFor(who: Holder, t: Translate): string {
  const time = spoken(who.seconds, t)
  if (!who.atLeast) return t('signals.busy.running', { time })
  return who.seconds < 60 ? '' : t('signals.busy.runningAtLeast', { time })
}

/** The tag panel says, before the click, that the run will wait in line or share the GPU (never silently). */
export function GpuNotice({ plan }: { plan: TagStartPlan }) {
  const t = useT()
  if (plan.mode === 'free') return null
  const who = plan.who
  const name = who ? workName(who, t) : ''
  const running = who ? runningFor(who, t) : ''
  let text: string
  if (plan.mode === 'share') text = t('signals.tag.share', { who: name, running })
  else text = who ? t('signals.tag.queueNamed', { who: name, running }) : t('signals.tag.queue')
  return (
    <p className={styles.gpu} data-mode={plan.mode} role="status" data-testid="tag-gpu-notice">
      {text}
    </p>
  )
}
