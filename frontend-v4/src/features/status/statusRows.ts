import { useEffect } from 'react'
import { useLibraryHealth, useMissingCount } from '../../api/queries'
import { useT, type MessageKey } from '../../i18n'
import { useApp } from '../../state/store'
import { scoreLibrary } from '../info/aesthetic'
import { pauseJob, useJobs } from '../jobs/jobs'
import { isFinished, type JobKind } from '../jobs/progress'
import { useToasts } from '../../ui/toasts'
import { useSelectionDialog } from '../selection/dialogs'
import { useSimilarStatus } from '../similar/status'
import { startColorAnalysis, useColorsMissing } from './colorAnalysis'
import { readErrorsOnly, shouldOfferTextRecovery } from './health'
import { stillHidden, useRowHides } from './hideRows'
import { startRepair, useTextRecoveryLeft } from './reparse'

// The rail's library status: only what needs attention, each with its fix.

export interface StatusAction {
  label: string
  run: () => void
  busy?: boolean
  title?: string
  testId?: string
}

export interface StatusRow {
  key: MessageKey
  n: number
  /** Names the row for tests and for the screen reader (status-row-<id>). */
  id?: string
  /** Quiet rows are chores, not problems (colour analysis). */
  quiet?: boolean
  /** Its own sentence instead of the key's (a run's live count). */
  text?: string
  action?: StatusAction
  /** Smaller ways out beside the action: hide the row. */
  extra?: StatusAction[]
}

export function useRunning(kind: JobKind): boolean {
  return useJobs((s) => s.jobs.some((j) => j.kind === kind && !isFinished(j.progress.status)))
}

/**
 * Images still waiting for their generation details: an import is reading
 * them (see its progress), or one stopped before it finished (import the
 * folder again and they are read).
 */
export function usePendingFix(): { label: string; run: () => void } {
  const t = useT()
  const importing = useRunning('scan')
  if (importing) return { label: t('status.fix.progress'), run: () => useJobs.getState().setDrawerOpen(true) }
  return { label: t('status.fix.reimportShort'), run: () => useSelectionDialog.getState().showFor('import', null, 1) }
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
  const scoring = useRunning('aesthetic')
  const recovering = useRunning('reparse')
  const rereading = useRunning('reread')
  const similar = useSimilarStatus()
  const pendingFix = usePendingFix()
  const colorsJob = useJobs((s) => s.jobs.find((j) => j.kind === 'colors' && !isFinished(j.progress.status)))
  const hiddenColorsJob = useRowHides((s) => s.colorsJobId)
  const hiddenAt = useRowHides((s) => s.unreadableAt)
  const c = health.data?.issue_counts
  // The missing-files summary groups every unreadable row; its count is the live one.
  const missingN = missing.data ?? c?.unreadable ?? 0
  // Unreadable rows the summary has not counted yet (it refreshes on its own clock).
  const uncounted = Math.max(0, (c?.unreadable ?? 0) - missingN)
  const unreadableTotal = missingN + uncounted
  // A different number is news: the hidden line comes back.
  useEffect(() => {
    if (health.data && hiddenAt !== null && !stillHidden(hiddenAt, unreadableTotal)) useRowHides.getState().showUnreadable()
  }, [health.data, hiddenAt, unreadableTotal])
  if (!health.data || !c) return null
  const untagged = c.untagged ?? 0
  const unreadableHidden = stillHidden(hiddenAt, unreadableTotal)
  const hideUnreadable: StatusAction = {
    label: t('partialsa.unreadable.hide'),
    title: t('partialsa.unreadable.hideTitle'),
    run: () => {
      useRowHides.getState().hideUnreadable(unreadableTotal)
      useToasts.getState().push(t('partialsa.unreadable.hidden'), 'info')
    },
    testId: 'status-hide-unreadable',
  }
  const handleMissing = { label: t('status.handleMissing'), run: () => showFor('missing', null, missingN) }
  const readErrors = readErrorsOnly(health.data)
  const missingText = c.missing_text ?? 0
  // Colour analysis: the chore to start; while it runs, its live count with Pause or Resume and Hide.
  const colorsRow = (): StatusRow => {
    const missingColors = colors.data?.missing ?? 0
    if (!colorsJob) {
      return { key: 'status.colorsMissing', id: 'colors', n: missingColors, quiet: true, action: { label: t('status.analyse'), run: () => void startColorAnalysis(), testId: 'colors-analyse' } }
    }
    const p = colorsJob.progress
    const paused = p.paused === true
    const done = p.current.toLocaleString()
    const total = (p.total || colorsJob.count).toLocaleString()
    return {
      key: 'status.colorsMissing',
      id: 'colors',
      n: hiddenColorsJob === colorsJob.id ? 0 : Math.max(missingColors, 1),
      quiet: true,
      text: t(paused ? 'partialsa.colors.paused' : 'partialsa.colors.running', { done, total }),
      action: {
        label: t(paused ? 'partialsa.colors.resume' : 'partialsa.colors.pause'),
        run: () => void pauseJob(colorsJob, !paused),
        busy: p.status !== 'running',
        testId: 'colors-pause',
      },
      extra: [{ label: t('partialsa.colors.hide'), title: t('partialsa.colors.hideTitle'), run: () => useRowHides.getState().hideColors(colorsJob.id), testId: 'colors-hide' }],
    }
  }
  return [
    { key: 'status.pending', n: c.metadata_pending ?? 0, quiet: true, action: pendingFix },
    { key: 'rail.untagged', n: untagged, action: { label: t('sel.tag'), run: () => showFor('tag', null, untagged) } },
    { key: 'rail.missing', id: 'missing', n: unreadableHidden ? 0 : missingN, action: handleMissing, extra: [hideUnreadable] },
    { key: 'rail.unreadable', id: 'unreadable', n: unreadableHidden ? 0 : uncounted, action: handleMissing, extra: [hideUnreadable] },
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
    colorsRow(),
    {
      key: 'info.aes.missing',
      n: c.missing_aesthetic ?? 0,
      quiet: true,
      action: { label: scoring ? t('info.aes.scoring') : t('info.aes.scoreAll'), run: () => void scoreLibrary(), busy: scoring },
    },
    ...similar,
  ]
}
