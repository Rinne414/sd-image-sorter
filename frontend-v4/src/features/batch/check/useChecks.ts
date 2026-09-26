import { useMemo } from 'react'
import type { Batch } from '../../../api/types'
import { useBatchProject } from '../datasetApi'
import { formFromSettings, readBatchDataset } from '../datasetSettings'
import { useProjectHeads } from '../datasetTagApi'
import type { Entry } from '../entries'
import { captionIssues, tagStyleIssues } from './captionChecks'
import { checkScope, sentKeys, useAudit, useFinalCaptions, useFolderAesthetic, useHealth, useReviewQueue } from './checkApi'
import { auditIssues, healthIssues, keyIndex, maskIssues, mergeIssues, projectIssues, purityIssues, reviewIssues, type CheckIssue } from './checkIssues'
import { useMaskStatus } from '../masks/maskApi'
import type { CheckOptions } from './checkOptions'
import { usePurityResults } from './purityRun'

/** What one source is doing: not for these images, still asking, done (and what it covered), or failed. */
export type SourceStatus = 'na' | 'checking' | 'done' | 'failed'

export interface SourceState {
  id: 'captions' | 'health' | 'review' | 'audit' | 'aesthetic'
  status: SourceStatus
  error: string | null
  /** A note the source gave (near duplicates unavailable, a check cut short). */
  warning: 'phashError' | 'phashLimited' | 'healthCut' | null
  /** How many images it covered. */
  count: number
  retry: () => void
}

interface QueryLike {
  isError: boolean
  error: Error | null
  isFetching: boolean
  data?: unknown
  refetch: () => unknown
}

function stateOf(id: SourceState['id'], q: QueryLike, applies: boolean, count: number, warning: SourceState['warning'] = null): SourceState {
  const status: SourceStatus = !applies ? 'na' : q.isError ? 'failed' : q.isFetching || q.data === undefined ? 'checking' : 'done'
  return { id, status, error: q.isError ? (q.error?.message ?? '?') : null, warning: status === 'done' ? warning : null, count, retry: () => void q.refetch() }
}

/** Every check over the batch, merged into one list of issues. `run` goes up with "Check again". */
export function useChecks(batch: Batch, entries: readonly Entry[], o: CheckOptions, run: number) {
  const view = useBatchProject(batch).data
  const form = useMemo(() => (view ? formFromSettings(view.project.settings, readBatchDataset(batch.settings)) : null), [view, batch.settings])
  const heads = useProjectHeads(view)
  const finals = useFinalCaptions(batch, view, form, entries, heads.data)
  const ratings = !!form && !form.removeCategories.includes('rating')
  const review = useReviewQueue(batch, entries, o, ratings, run)
  const audit = useAudit(batch, entries, o, run)
  const aesthetic = useFolderAesthetic(batch, entries, o, run)
  const health = useHealth(batch, entries, form, finals.data, run)
  const purity = usePurityResults((s) => s.byBatch[batch.id])
  const scope = useMemo(() => checkScope(entries), [entries])
  const masks = useMaskStatus(scope.ids)
  const exportsMasks = !!view && view.project.settings.trainer.mask_export !== 'none'

  const issues: CheckIssue[] = useMemo(() => {
    const index = keyIndex(entries)
    return mergeIssues(
      [
        projectIssues(entries),
        finals.data && form ? captionIssues(finals.data.captions, form) : [],
        heads.data && form ? tagStyleIssues(heads.data, form.normalizeUnderscores) : [],
        review.data ? reviewIssues(review.data, index) : [],
        audit.data ? auditIssues(audit.data, index) : [],
        aesthetic.data ? auditIssues(aesthetic.data, index) : [],
        health.data ? healthIssues(health.data, index, { ratingsInCaptions: ratings }) : [],
        purity ? purityIssues(purity, index) : [],
        masks.data ? maskIssues(masks.data, scope.ids, index, exportsMasks) : [],
      ],
      entries.map((e) => e.key),
    )
  }, [entries, finals.data, heads.data, form, review.data, audit.data, aesthetic.data, health.data, purity, ratings, masks.data, scope.ids, exportsMasks])

  const summary = audit.data?.summary
  const auditWarning = summary?.near_duplicate_error ? 'phashError' : summary?.near_duplicate_check_limited ? 'phashLimited' : null
  const captionCount = finals.data ? finals.data.captions.size + finals.data.failed.size : 0
  const sources: SourceState[] = [
    stateOf('captions', heads.isError ? heads : { ...finals, isFetching: finals.isFetching || heads.isFetching }, entries.length > 0, captionCount),
    stateOf('health', health, scope.ids.length > 0, health.data?.images ?? 0, health.data?.images_truncated ? 'healthCut' : null),
    stateOf('review', review, scope.ids.length > 0, scope.ids.length),
    stateOf('audit', audit, scope.ids.length + scope.paths.length > 0, audit.data?.sent.length ?? 0, auditWarning),
    ...(o.scoreFolders ? [stateOf('aesthetic', aesthetic, scope.paths.length > 0 && o.minAesthetic > 0, scope.paths.length)] : []),
  ]
  // Images added after the last costly check (the audit and review queue run again only when asked).
  const sent = audit.data ? new Set(audit.data.sent) : null
  const unchecked = sent ? sentKeys(entries).filter((key) => !sent.has(key)).length : 0
  return { issues, sources, form, finals: finals.data, scope, unchecked }
}
