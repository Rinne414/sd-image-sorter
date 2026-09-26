import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, unwrap } from '../../api/client'
import { useT } from '../../i18n'
import { tailOfPath } from '../../lib/paths'
import { useApp } from '../../state/store'
import { useJobs } from '../jobs/jobs'
import { openFolderPath } from '../library/fileActions'
import { isRunning, knownReason, readRun, type RunFailure, type RunRecord, type RunState } from './rules'
import { useRules, undoRulesRun } from './rulesActions'
import { splitName } from './RulesParts'
import { useSort } from './sortStore'
import styles from './SortPage.module.css'

// A sort-by-condition run on the Sort tab: its progress while it runs (also in
// the Jobs drawer), then what happened, with undo; the same for the undo.

/** How often the page asks for progress while the run goes on. */
const POLL_MS = 700
/** Failures listed by name. */
const LISTED = 50

type Translate = ReturnType<typeof useT>

function useRunProgress(token: string): RunState | null {
  const query = useQuery({
    queryKey: ['sort-rules-run', token],
    queryFn: async ({ signal }) => readRun(unwrap(await api.GET('/api/batch-move/progress', { signal })), token),
    refetchInterval: (q) => (q.state.data && isRunning(q.state.data) ? POLL_MS : false),
  })
  return query.data ?? null
}

function reasonText(t: Translate, reason: string): string {
  const known = knownReason(reason)
  if (!known) return reason
  return t(`sort.rules.reason.${known.key}`, { folder: known.folder ?? '' })
}

function Failures({ failures, total, title }: { failures: RunFailure[]; total: number; title: string }) {
  const t = useT()
  if (total === 0) return null
  return (
    <div className={styles.failures} data-testid="sort-rules-failures">
      <p className={styles.warnLine}>{title}</p>
      <ul>
        {failures.slice(0, LISTED).map((f, i) => (
          <li key={`${f.name}-${i}`}>
            <span className="mono">{f.name}</span> — {reasonText(t, f.reason)}
          </li>
        ))}
      </ul>
      {total > Math.min(failures.length, LISTED) && <p className={styles.note}>{t('sort.rules.moreFailures', { n: total - Math.min(failures.length, LISTED) })}</p>}
    </div>
  )
}

/** The line that says where the run is, or what it did. */
function headline(t: Translate, record: RunRecord, run: RunState): string {
  const copy = record.operation === 'copy'
  const folder = tailOfPath(record.destination, 60)
  if (run.status === 'lost') return t('sort.rules.gone')
  if (run.status === 'error') return t('sort.rules.failedRun', { reason: run.message || '?' })
  if (run.kind === 'undo') {
    if (isRunning(run)) return t('sort.rules.undoing', { at: run.current, total: run.total })
    if (run.status === 'cancelled') return t('sort.rules.undoStopped', { n: run.succeeded, total: run.total })
    return t(copy ? 'sort.rules.undoneCopy' : 'sort.rules.undone', { n: run.succeeded })
  }
  const op = t(copy ? 'sort.rules.op.copying' : 'sort.rules.op.moving')
  if (isRunning(run)) return t('sort.rules.running', { op, at: run.current, total: run.total })
  if (run.status === 'cancelled') return t('sort.rules.stopped', { op: t(copy ? 'sort.rules.op.copied' : 'sort.rules.op.moved'), n: run.succeeded, total: run.total })
  if (record.groups.length > 1) return t(copy ? 'sort.rules.doneCopyRules' : 'sort.rules.doneMoveRules', { n: run.succeeded, rules: record.groups.length })
  return t(copy ? 'sort.rules.doneCopy' : 'sort.rules.doneMove', { n: run.succeeded, folder })
}

export function RulesRun({ record }: { record: RunRecord }) {
  const t = useT()
  const qc = useQueryClient()
  const run = useRunProgress(record.token)
  const [problem, setProblem] = useState<string | null>(null)
  const copy = record.operation === 'copy'

  // A finished undo is remembered, so the run is not offered for undo again.
  useEffect(() => {
    if (run?.kind === 'undo' && run.status === 'done' && record.phase !== 'undone') useRules.getState().set({ ...record, phase: 'undone' })
  }, [run?.kind, run?.status, record])

  const undo = async () => {
    setProblem(await undoRulesRun(record))
    void qc.invalidateQueries({ queryKey: ['sort-rules-run', record.token] })
  }
  const close = (to: 'setup' | 'library') => {
    useRules.getState().set({ ...record, open: false })
    // Another set means the setup, even over a saved one-at-a-time sort.
    if (to === 'setup') useSort.getState().openSetup(null)
    else useApp.getState().setPage('library')
  }

  const running = run !== null && isRunning(run)
  const canUndo = run !== null && !running && record.phase !== 'undone' && (run.kind === 'sort' || run.status === 'cancelled' || run.status === 'lost')
  const split = record.splitBy === 'none' ? '' : ` · ${splitName(t, record.splitBy)}`
  const op = t(copy ? 'sort.rules.op.copied' : 'sort.rules.op.moved')

  return (
    <section className={styles.page} data-testid="sort-rules-run" data-kind={run?.kind} data-status={run?.status}>
      <div className={styles.sheet}>
        <h1 className={styles.title}>{t('sort.rules.title')}</h1>
        {record.groups.length > 1 ? (
          <RunGroups record={record} />
        ) : (
          <p className={`${styles.optionHint} mono`} title={record.destination}>
            {tailOfPath(record.destination, 90)}
            {split}
          </p>
        )}
        {run && (
          <>
            <p className={styles.lede} data-testid="sort-rules-headline">
              {headline(t, record, run)}
            </p>
            {running && (
              <div className={styles.runBar} aria-hidden>
                <span style={{ width: `${run.total ? (run.current / run.total) * 100 : 0}%` }} />
              </div>
            )}
            <Failures failures={run.failures} total={run.failed} title={run.kind === 'undo' ? t('sort.rules.notRestored', { n: run.failed }) : t('sort.rules.notMoved', { n: run.failed, op })} />
          </>
        )}
        {problem && (
          <p className={styles.error} role="alert">
            {problem}
          </p>
        )}
        {canUndo && <p className={styles.note}>{t(copy ? 'sort.rules.undoHintCopy' : 'sort.rules.undoHintMove')}</p>}
        <div className={styles.doneActions}>
          {running ? (
            <>
              <button type="button" className="btn" onClick={() => void api.POST('/api/batch-move/cancel')} data-testid="sort-rules-stop">
                {t('sort.rules.stop')}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => useJobs.getState().setDrawerOpen(true)}>
                {t('sort.rules.inJobs')}
              </button>
            </>
          ) : (
            <>
              {canUndo && (
                <button type="button" className="btn" onClick={() => void undo()} data-testid="sort-rules-undo">
                  {t('sort.rules.undo')}
                </button>
              )}
              {record.groups.length <= 1 && (
                <button type="button" className="btn" onClick={() => void openFolderPath(record.destination)} data-testid="sort-rules-open">
                  {t('sort.rules.openFolder')}
                </button>
              )}
            </>
          )}
          <span className={styles.gap} />
          <button type="button" className="btn" onClick={() => close('setup')} data-testid="sort-rules-again">
            {t('sort.rules.again')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => close('library')} data-testid="sort-rules-back">
            {t('sort.done.back')}
          </button>
        </div>
      </div>
    </section>
  )
}

/** A run by several rules: each rule's folder and count, with its folder one click away. */
function RunGroups({ record }: { record: RunRecord }) {
  const t = useT()
  return (
    <ol className={styles.runGroups} data-testid="sort-rules-groups">
      {record.groups.map((g, i) => (
        <li key={i} data-testid="sort-rules-group">
          <span className={styles.optionHint}>{t('sort.rules.ruleN', { n: i + 1 })}</span>
          <span className="mono" title={g.destination}>
            {tailOfPath(g.destination, 70)}
            {g.splitBy === 'none' ? '' : ` · ${splitName(t, g.splitBy)}`}
          </span>
          <span className={styles.optionHint}>{t('sort.rules.groupCount', { n: g.count })}</span>
          <button type="button" className="btn btn-ghost" onClick={() => void openFolderPath(g.destination)}>
            {t('sort.rules.openFolder')}
          </button>
        </li>
      ))}
    </ol>
  )
}
