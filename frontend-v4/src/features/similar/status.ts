import type { MessageKey } from '../../i18n'
import { useT } from '../../i18n'
import { useJobs } from '../jobs/jobs'
import { isFinished } from '../jobs/progress'
import { withClip } from './clip'
import { useSimilarDialogs } from './dialogs'
import { startIndexing, useDuplicateReview, useIndexStats } from './similarApi'

// What the library status says about duplicates and the similarity index.
// Duplicates speak when the last scan found groups that still exist; the
// index only once it is in use and has fallen behind (new images).

export interface SimilarStatusRow {
  key: MessageKey
  n: number
  quiet?: boolean
  action?: { label: string; run: () => void; busy?: boolean }
}

export function useSimilarStatus(): SimilarStatusRow[] {
  const t = useT()
  const review = useDuplicateReview()
  const stats = useIndexStats()
  const indexing = useJobs((s) => s.jobs.some((j) => j.kind === 'embed' && !isFinished(j.progress.status)))
  const first = review.data?.pages[0]
  // Groups beyond the first page are counted as the scan found them.
  const groups = first ? first.groups.length + Math.max(0, first.page.total_groups - first.page.groups.length) : 0
  const embedded = stats.data?.embedded_count ?? 0
  const pending = stats.data?.pending_count ?? 0
  return [
    {
      key: 'sim.dup.status',
      n: groups,
      action: { label: t('sim.dup.statusAction'), run: () => useSimilarDialogs.getState().setDuplicates(true) },
    },
    {
      key: 'sim.index.pending',
      n: embedded > 0 ? pending : 0,
      quiet: true,
      action: {
        label: indexing ? t('sim.index.building') : t('sim.index.build'),
        run: () => void withClip(() => void startIndexing()),
        busy: indexing,
      },
    },
  ]
}
