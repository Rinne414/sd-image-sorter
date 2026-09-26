import { useLibraryHealth, useMissingCount } from '../../api/queries'
import { useT, type MessageKey } from '../../i18n'
import { useApp } from '../../state/store'
import { scoreLibrary } from '../info/aesthetic'
import { useJobs } from '../jobs/jobs'
import { isFinished, type JobKind } from '../jobs/progress'
import { useSelectionDialog } from '../selection/dialogs'
import { useSimilarStatus } from '../similar/status'
import { startColorAnalysis, useColorsMissing } from './colorAnalysis'
import { readErrorsOnly, shouldOfferTextRecovery } from './health'
import { startRepair, useTextRecoveryLeft } from './reparse'

// The rail's library status: only what needs attention, each with its fix.

export interface StatusRow {
  key: MessageKey
  n: number
  /** Quiet rows are chores, not problems (colour analysis). */
  quiet?: boolean
  action?: { label: string; run: () => void; busy?: boolean }
}

export function useRunning(kind: JobKind): boolean {
  return useJobs((s) => s.jobs.some((j) => j.kind === kind && !isFinished(j.progress.status)))
}

/** The rows to show, in order; `null` until the report has loaded. */
export function useStatusRows(): StatusRow[] | null {
  const t = useT()
  const health = useLibraryHealth()
  const missing = useMissingCount()
  const colors = useColorsMissing()
  const showFor = useSelectionDialog((s) => s.showFor)
  const libraryId = useApp((s) => s.libraryId)
  const left = useTextRecoveryLeft((s) => s.byLibrary[libraryId])
  const analysing = useRunning('colors')
  const scoring = useRunning('aesthetic')
  const recovering = useRunning('reparse')
  const rereading = useRunning('reread')
  const similar = useSimilarStatus()
  if (!health.data) return null
  const c = health.data.issue_counts
  const untagged = c.untagged ?? 0
  // The missing-files summary groups every unreadable row; its count is the live one.
  const missingN = missing.data ?? c.unreadable ?? 0
  const handleMissing = { label: t('status.handleMissing'), run: () => showFor('missing', null, missingN) }
  const readErrors = readErrorsOnly(health.data)
  const missingText = c.missing_text ?? 0
  return [
    { key: 'rail.untagged', n: untagged, action: { label: t('sel.tag'), run: () => showFor('tag', null, untagged) } },
    { key: 'rail.missing', n: missingN, action: handleMissing },
    // Unreadable rows the summary has not counted yet (it refreshes on its own clock).
    { key: 'rail.unreadable', n: Math.max(0, (c.unreadable ?? 0) - missingN), action: handleMissing },
    {
      key: 'rail.metaError',
      n: readErrors,
      action: { label: t(rereading ? 'status.fix.rereading' : 'status.fix.reread'), run: () => void startRepair('reread', readErrors), busy: rereading },
    },
    {
      key: 'status.missingText',
      n: recovering || shouldOfferTextRecovery(missingText, left) ? missingText : 0,
      quiet: true,
      action: { label: t(recovering ? 'status.fix.recovering' : 'status.fix.recover'), run: () => void startRepair('reparse', missingText), busy: recovering },
    },
    {
      key: 'status.colorsMissing',
      n: colors.data?.missing ?? 0,
      quiet: true,
      action: { label: analysing ? t('status.analysing') : t('status.analyse'), run: () => void startColorAnalysis(), busy: analysing },
    },
    {
      key: 'info.aes.missing',
      n: c.missing_aesthetic ?? 0,
      quiet: true,
      action: { label: scoring ? t('info.aes.scoring') : t('info.aes.scoreAll'), run: () => void scoreLibrary(), busy: scoring },
    },
    ...similar,
  ]
}
