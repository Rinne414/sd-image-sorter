import { translate, useLang, type MessageKey, type Params } from '../../i18n'
import { tailOfPath } from '../../lib/paths'
import type { Job } from './jobs'
import type { JobKind } from './progress'
import { queuedKey } from './queued'

// What the Jobs drawer and a job's toast say about a job, by kind and state.
// Pure (no stores, no requests), so it can be tested on its own.

const tr = (key: MessageKey, params?: Params) => translate(useLang.getState().lang, key, params)

const RUNNING: Record<JobKind, MessageKey> = {
  move: 'jobs.running.move',
  copy: 'jobs.running.copy',
  trash: 'jobs.running.trash',
  remove: 'jobs.running.remove',
  tag: 'jobs.running.tag',
  install: 'jobs.running.install',
  tags: 'jobs.done.tags',
  colors: 'jobs.running.colors',
  reconnect: 'jobs.running.reconnect',
  scan: 'jobs.running.scan',
  detect: 'jobs.running.detect',
  refine: 'jobs.running.refine',
  adjust: 'jobs.running.adjust',
  embed: 'sim.job.running.embed',
  dupscan: 'sim.job.running.dupscan',
  smarttag: 'dataset.job.running',
  purity: 'dataset.check.purity.running',
  purityget: 'dataset.check.purity.downloading',
  masks: 'dataset.masks.job.running',
  aesthetic: 'info.aes.job.running',
  dsexport: 'dataset.export.job.running',
  reparse: 'status.reparse.running',
  reread: 'status.reread.running',
  sortrules: 'sort.rules.job.running', // sortrules
  sortundo: 'sort.rules.job.undoing', // sortundo
  ollama: 'jobs.running.install', // ollama: "Downloading <model>"
  artist: 'tools.artist.job.running', // artist
}

const DONE: Record<JobKind, MessageKey> = {
  move: 'jobs.done.move',
  copy: 'jobs.done.copy',
  trash: 'jobs.done.trash',
  remove: 'jobs.done.remove',
  tag: 'jobs.done.tag',
  install: 'jobs.done.install',
  tags: 'jobs.done.tags',
  colors: 'jobs.done.colors',
  reconnect: 'jobs.done.reconnect',
  scan: 'jobs.done.scan',
  detect: 'jobs.done.detect',
  refine: 'jobs.done.refine',
  adjust: 'jobs.done.adjust',
  embed: 'sim.job.done.embed',
  dupscan: 'sim.job.done.dupscan',
  smarttag: 'dataset.job.done',
  purity: 'dataset.check.purity.done',
  purityget: 'dataset.check.purity.downloaded',
  masks: 'dataset.masks.job.done',
  aesthetic: 'info.aes.job.done',
  dsexport: 'dataset.export.job.done',
  reparse: 'status.reparse.done',
  reread: 'status.reread.done',
  sortrules: 'sort.rules.job.done', // sortrules
  sortundo: 'sort.rules.job.undone', // sortundo
  ollama: 'jobs.done.install', // ollama: "<model> is ready"
  artist: 'tools.artist.job.done', // artist
}

/** An install that can only be used after a restart says so, never "is ready". */
const doneKey = (job: Job): MessageKey =>
  job.words?.done ?? (job.kind === 'install' && job.progress.needsRestart ? 'jobs.done.installRestart' : DONE[job.kind])

/** One line that says what happened (or is happening) to this job. */
export function jobHeadline(job: Job): string {
  const p = job.progress
  const params = { n: p.total || job.count, name: job.label ?? '' }
  const running = job.words?.running ?? RUNNING[job.kind]
  switch (p.status) {
    case 'queued':
      return tr(queuedKey(job.kind), { what: tr(running, params) })
    case 'running':
      return tr(running, params)
    case 'cancelling':
      return `${tr(running, params)} · ${tr('jobs.stopping')}`
    case 'cancelled':
      return tr('jobs.stopped', { done: p.current, total: p.total || job.count })
    case 'error':
      return p.lost ? tr('jobs.installLost', params) : tr('jobs.error', { reason: p.message || '?' })
    case 'idle':
      return tr('jobs.reset')
    case 'done': {
      // Chinese joins the destination without a space; English carries its own.
      let text = tr(doneKey(job), { n: p.succeeded, name: job.label ?? '' })
      if (job.destination && (job.kind === 'move' || job.kind === 'copy')) text += tr('jobs.to', { path: tailOfPath(job.destination, 40) })
      if (p.updated) text += tr('jobs.updatedSuffix', { n: p.updated })
      if (p.failedCount) text += tr('jobs.failedSuffix', { n: p.failedCount })
      if (p.alreadyGone) text += tr('jobs.alreadyGone', { n: p.alreadyGone })
      return text
    }
  }
}
