import { useMemo } from 'react'
import type { Batch } from '../../../api/types'
import { useT, type MessageKey } from '../../../i18n'
import { readdEntries } from '../datasetApi'
import type { ProjectSettings } from '../datasetSettings'
import { useProjectHeads } from '../datasetTagApi'
import type { Entry } from '../entries'
import pix from '../ExportStep.module.css'
import { CheckIssues } from './CheckIssues'
import styles from './DatasetExport.module.css'
import { checkAndExport, leaveOut, stopDsRun, useDsRuns, type DsRun } from './exportRun'
import { exportProblems, formatOf, splitEntries, stepsEstimate, type Choices, type LeftOut } from './plan'
import { LEFT_OUT_KEY, PROBLEM_KEY } from './texts'
import type { ExportOptions } from './useExportOptions'

const FIRST_RUN: Choices = { skipBlocked: false, allowEmpty: false }

interface Props {
  batch: Batch
  o: ExportOptions
  s: ProjectSettings
  entries: readonly Entry[]
  remove: (keys: readonly string[]) => void
  onOpen: (key: string) => void
}

function Count({ label, value, tone, testId }: { label: string; value: string; tone?: 'warn'; testId: string }) {
  return (
    <div className={pix.count} data-tone={tone}>
      <dt>{label}</dt>
      <dd className="mono" data-testid={testId}>
        {value}
      </dd>
    </div>
  )
}

/** What the export writes, in one line. */
function Writes({ s, n, nl }: { s: ProjectSettings; n: number; nl: boolean }) {
  const t = useT()
  const format = formatOf(s)
  const parts = [t(`dataset.export.writes.${format}` as MessageKey, { n, repeats: s.trainer.repeats, keep: s.trainer.keep_tokens })]
  if (nl) parts.push(t('dataset.export.writes.nl', { n }))
  if (s.trainer.mask_export !== 'none') parts.push(t('dataset.export.writes.masks'))
  return (
    <p className={styles.sample} data-testid="ds-writes">
      {parts.join(t('batch.listSep'))}
    </p>
  )
}

function LeftOutBox({ batch, leftOut, remove }: { batch: Batch; leftOut: LeftOut[]; remove: Props['remove'] }) {
  const t = useT()
  const changed = leftOut.filter((l) => l.reason === 'changed').map((l) => l.key)
  return (
    <div className={pix.problem} data-tone="warn" data-testid="ds-left-out">
      <p>{t('dataset.export.leftOutTitle', { n: leftOut.length })}</p>
      <ul className={styles.leftOut}>
        {leftOut.map((l) => (
          <li key={l.key} data-reason={l.reason}>
            <span title={l.name}>{l.name}</span>
            <span>{t(LEFT_OUT_KEY[l.reason])}</span>
          </li>
        ))}
      </ul>
      <div className={styles.actions}>
        {changed.length > 0 && (
          <button type="button" className="btn" onClick={() => void readdEntries(batch.id, changed)} data-testid="ds-readd">
            {t('dataset.export.readd', { n: changed.length })}
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={() => remove(leftOut.map((l) => l.key))} data-testid="ds-left-out-remove">
          {t('dataset.export.takeOut', { n: leftOut.length })}
        </button>
      </div>
    </div>
  )
}

function Running({ batch, run }: { batch: Batch; run: Extract<DsRun, { state: 'running' }> }) {
  const t = useT()
  const pct = run.total ? Math.min(100, (run.current / run.total) * 100) : 0
  return (
    <div className={styles.progress} role="status" data-testid="ds-running" data-phase={run.phase}>
      <div className={styles.progressLine}>
        <strong>{t(run.phase === 'check' ? 'dataset.export.checking' : 'dataset.export.exporting', { done: run.current, total: run.total })}</strong>
        <button type="button" className="btn" onClick={() => stopDsRun(batch.id)} disabled={run.cancelling} data-testid="ds-stop">
          {t('jobs.stop')}
        </button>
      </div>
      <div className={styles.meter} aria-hidden>
        <span style={{ width: `${pct}%` }} />
      </div>
      {run.item && (
        <div className={styles.progressLine}>
          <span title={run.item}>{run.item}</span>
        </div>
      )}
    </div>
  )
}

function Stopped({ batch, run, entries, send }: { batch: Batch; run: Extract<DsRun, { state: 'refused' | 'failed' }>; entries: readonly Entry[]; send: number }) {
  const t = useT()
  if (run.state === 'failed') {
    return (
      <div className={pix.problem} data-tone="danger" role="alert" data-testid="ds-failed">
        <p>{run.message}</p>
      </div>
    )
  }
  const key = run.key
  const name = entries.find((e) => e.key === key)?.filename ?? key ?? '?'
  return (
    <div className={pix.problem} data-tone="danger" role="alert" data-testid="ds-refused">
      <p title={run.message}>{t('dataset.export.refused', { name })}</p>
      {key && (
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            leaveOut(batch.id, key)
            void checkAndExport(batch, FIRST_RUN)
          }}
          data-testid="ds-refused-leave"
        >
          {t('dataset.export.refusedLeave', { n: Math.max(0, send - 1) })}
        </button>
      )}
    </div>
  )
}

/** Beside the form: what goes, what is left out and why, the check's findings, and the one button. */
export function DatasetPreflight({ batch, o, s, entries, remove, onOpen }: Props) {
  const t = useT()
  const run = useDsRuns((st) => st.runs[batch.id])
  const refused = useDsRuns((st) => st.leftOut[batch.id])
  const heads = useProjectHeads(o.view)
  const { send, leftOut } = useMemo(() => splitEntries(entries, new Set(refused ?? [])), [entries, refused])
  const folderImages = send.filter((e) => e.imageId === null).length
  const problems = exportProblems(s, send.length, folderImages, o.v4.nl_sidecar)
  const edited = heads.data ? send.filter((e) => heads.data.get(e.key)?.revisionId !== undefined).length : null
  const format = formatOf(s)
  const running = run?.state === 'running'
  const choices = run?.state === 'blocked' ? run.choices : FIRST_RUN
  const steps = stepsEstimate(send.length, s.trainer.repeats, s.trainer.batch, s.planning.epochs)

  return (
    <aside className={pix.panel} data-testid="ds-preflight">
      <h3 className={pix.panelTitle}>{t('dataset.export.preflight')}</h3>
      <dl className={pix.counts}>
        <Count label={t('dataset.export.count.send')} value={String(send.length)} testId="ds-count-send" />
        <Count label={t('dataset.export.count.left')} value={String(leftOut.length)} tone={leftOut.length ? 'warn' : undefined} testId="ds-count-left" />
        <Count label={t('dataset.export.count.edited')} value={edited === null ? '…' : String(edited)} testId="ds-count-edited" />
        {format !== 'beside' && <Count label={t('dataset.export.count.steps')} value={steps.toLocaleString()} testId="ds-count-steps" />}
      </dl>
      <Writes s={s} n={send.length} nl={o.v4.nl_sidecar} />
      {!s.caption_render.trigger.trim() && <p className={styles.note} data-tone="warn">{t('dataset.export.noTrigger')}</p>}
      {leftOut.length > 0 && <LeftOutBox batch={batch} leftOut={leftOut} remove={remove} />}
      {run?.state === 'blocked' && (
        <CheckIssues report={run.report} entries={entries} choices={run.choices} isPackage={s.trainer.config !== 'none'} onRemove={remove} onOpen={onOpen} onRerun={(c) => void checkAndExport(batch, c)} />
      )}
      {(run?.state === 'refused' || run?.state === 'failed') && <Stopped batch={batch} run={run} entries={entries} send={send.length} />}
      {problems.map((p) => (
        <p key={p} className={pix.fieldProblem} data-testid="ds-problem" data-problem={p}>
          {t(PROBLEM_KEY[p])}
        </p>
      ))}
      {running ? (
        <Running batch={batch} run={run} />
      ) : (
        <button
          type="button"
          className={`btn btn-primary ${pix.exportButton}`}
          disabled={problems.length > 0}
          onClick={() => void checkAndExport(batch, choices)}
          data-testid="ds-export-run"
        >
          {leftOut.length > 0 ? t('dataset.export.runLeaving', { n: send.length, m: leftOut.length }) : t('dataset.export.run', { n: send.length })}
        </button>
      )}
      <p className={styles.note}>{t('dataset.export.howItRuns')}</p>
    </aside>
  )
}
