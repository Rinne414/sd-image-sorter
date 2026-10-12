import type { MessageKey } from '../../i18n'
import type { JobKind } from './progress'

/** Kinds that queue behind a tagging run (the AI queue); other queued jobs only wait for their turn. */
const WAITS_FOR_TAGGING: ReadonlySet<JobKind> = new Set<JobKind>(['tag', 'smarttag'])

/** What a queued job's headline says it waits for. */
export const queuedKey = (kind: JobKind): MessageKey => (WAITS_FOR_TAGGING.has(kind) ? 'jobs.queued' : 'status.queuedBulk')
