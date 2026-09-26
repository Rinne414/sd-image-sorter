import { useRef } from 'react'
import { useLibraryHealth, useMissingCount } from '../../api/queries'
import type { LibraryHealth } from '../../api/types'
import { useT, type MessageKey } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { useSelectionDialog } from '../selection/dialogs'
import { useStatusDialogs } from './dialogs'
import { nextSteps, verdict, type Step, type StepKind } from './health'
import styles from './HealthDialog.module.css'
import { Breakdown, Duplicates, Folders, Samples } from './HealthSections'
import { startRepair } from './reparse'
import { useRunning } from './statusRows'

/** The library report: opened from the rail status or Ctrl K. */
export function HealthDialog() {
  const open = useStatusDialogs((s) => s.report)
  if (!open) return null
  return <Report onClose={() => useStatusDialogs.getState().setReport(false)} />
}

function Report({ onClose }: { onClose: () => void }) {
  const t = useT()
  const health = useLibraryHealth()
  const dupsRef = useRef<HTMLElement>(null)
  const footer = (
    <>
      <button type="button" className="btn" onClick={() => void health.refetch()} disabled={health.isFetching} data-testid="report-refresh">
        {t('status.report.refresh')}
      </button>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        {t('common.close')}
      </button>
    </>
  )
  return (
    <Dialog title={t('status.report.title')} onClose={onClose} footer={footer} testId="library-report" wide="x">
      {health.isPending && <p className={styles.note}>{t('status.report.loading')}</p>}
      {health.isError && <p className={styles.warn}>{t('status.report.failed', { reason: health.error.message })}</p>}
      {health.data && (
        <>
          <Summary report={health.data} />
          <NextSteps report={health.data} onClose={onClose} onShowNames={() => dupsRef.current?.scrollIntoView({ block: 'start' })} />
          <div className={styles.columns}>
            <Breakdown counts={health.data.issue_counts} />
            <div className={styles.stack}>
              <Duplicates report={health.data} sectionRef={dupsRef} onClose={onClose} />
              <Folders report={health.data} onClose={onClose} />
            </div>
          </div>
          <Samples report={health.data} onClose={onClose} />
        </>
      )}
    </Dialog>
  )
}

const pct = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? `${Number.isInteger(v) ? v : v.toFixed(1)}%` : '—')

function Summary({ report }: { report: LibraryHealth }) {
  const t = useT()
  const s = report.summary
  const v = verdict(s)
  const score = typeof s.quality_score === 'number' ? Math.round(s.quality_score) : null
  const kpis: [MessageKey, string][] = [
    ['status.kpi.images', s.total_images.toLocaleString()],
    ['status.kpi.ready', pct(s.metadata_ready_percent)],
    ['status.kpi.tagged', pct(s.tagged_percent)],
    ['status.kpi.act', s.actionable_count.toLocaleString()],
  ]
  return (
    <section className={styles.summary} data-verdict={v} data-testid="report-summary">
      <div className={styles.score}>
        <span className={styles.scoreLabel}>{t('status.report.score')}</span>
        <span className={styles.scoreValue}>
          <strong className="mono" data-testid="report-score">
            {score ?? '—'}
          </strong>
          <span className={styles.outOf}>{t('status.report.outOf')}</span>
        </span>
        <span className={styles.meter} aria-hidden>
          <span style={{ width: `${score ?? 0}%` }} />
        </span>
      </div>
      <div className={styles.verdict}>
        <h3 className={styles.verdictTitle}>{t(`status.verdict.${v}` as MessageKey)}</h3>
        <p className={styles.note}>{t(`status.verdict.${v}Detail` as MessageKey)}</p>
      </div>
      <dl className={styles.kpis}>
        {kpis.map(([key, value]) => (
          <div key={key} className={styles.kpi}>
            <dt>{t(key)}</dt>
            <dd className="mono">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

const STEP_TEXT: Record<StepKind, MessageKey> = {
  pending: 'status.next.pending',
  missing: 'status.next.missing',
  readErrors: 'status.next.readErrors',
  missingText: 'status.next.missingText',
  checkpoint: 'status.next.checkpoint',
  unattributed: 'status.next.unattributed',
  incomplete: 'status.next.incomplete',
  untagged: 'status.next.untagged',
  duplicates: 'status.next.duplicates',
}

interface Fix {
  label: string
  run: () => void
  busy?: boolean
}

function useFix(onClose: () => void, onShowNames: () => void): (step: Step) => Fix | null {
  const t = useT()
  const recovering = useRunning('reparse')
  const rereading = useRunning('reread')
  const leaveFor = (dialog: 'missing' | 'tag' | 'import', n: number) => () => {
    onClose()
    useSelectionDialog.getState().showFor(dialog, null, n)
  }
  return (step) => {
    switch (step.kind) {
      case 'pending':
        return null
      case 'missing':
        return { label: t('status.fix.missing'), run: leaveFor('missing', step.n) }
      case 'readErrors':
        return { label: t(rereading ? 'status.fix.rereading' : 'status.fix.reread'), run: () => void startRepair('reread', step.n), busy: rereading }
      case 'missingText':
        return { label: t(recovering ? 'status.fix.recovering' : 'status.fix.recover'), run: () => void startRepair('reparse', step.n), busy: recovering }
      case 'checkpoint':
      case 'unattributed':
      case 'incomplete':
        return { label: t('status.fix.reimport'), run: leaveFor('import', 1) }
      case 'untagged':
        return { label: t('status.fix.tag'), run: leaveFor('tag', step.n) }
      case 'duplicates':
        return { label: t('status.fix.showNames'), run: onShowNames }
    }
  }
}

function NextSteps({ report, onClose, onShowNames }: { report: LibraryHealth; onClose: () => void; onShowNames: () => void }) {
  const t = useT()
  const missing = useMissingCount()
  const fixFor = useFix(onClose, onShowNames)
  const steps = nextSteps(report, missing.data ?? report.issue_counts.unreadable ?? 0)
  return (
    <section className={styles.section} data-testid="report-next">
      <h3 className={styles.heading}>{t('status.next.title')}</h3>
      {steps.length === 0 ? (
        <p className={styles.note}>{t('status.next.none')}</p>
      ) : (
        <ul className={styles.steps}>
          {steps.map((step) => {
            const fix = fixFor(step)
            return (
              <li key={step.kind} className={styles.step} data-warn={step.warn || undefined} data-step={step.kind}>
                <span className={styles.stepMark} aria-hidden />
                <p className={styles.stepText}>{t(STEP_TEXT[step.kind], { n: step.n })}</p>
                {fix && (
                  <button type="button" className="btn" onClick={fix.run} disabled={fix.busy}>
                    {fix.label}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
