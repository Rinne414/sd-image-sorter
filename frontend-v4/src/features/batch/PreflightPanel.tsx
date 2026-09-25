import { useEffect, useRef, useState } from 'react'
import type { BatchItem } from '../../api/types'
import { useT } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import type { ExportFailure, ExportRun } from './exportApi'
import type { ExportSettings, MissingPolicy } from './exportSettings'
import styles from './ExportStep.module.css'
import type { Preflight } from './preflight'

interface Props {
  check: Preflight
  settings: ExportSettings
  run: ExportRun | undefined
  /** Censor edits of this batch still saving (or not saved). */
  unsaved: number
  /** Why exporting cannot start yet (no folder, watermark without text), or null. */
  notReady: string | null
  canCensor: boolean
  onExport: (policy: MissingPolicy, overwrite?: boolean) => void
  onGoCensor: () => void
  onGoName: () => void
}

function Names({ items, testId }: { items: readonly BatchItem[]; testId: string }) {
  return (
    <ul className={`${styles.names} mono`} data-testid={testId}>
      {items.map((item) => (
        <li key={item.image_id}>{item.filename}</li>
      ))}
    </ul>
  )
}

function Elapsed({ started }: { started: number }) {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return <span className="mono">{t('batch.export.elapsed', { s: Math.max(0, Math.round((now - started) / 1000)) })}</span>
}

/** Before the export button: what will be exported, and what needs a decision first. */
export function PreflightPanel(props: Props) {
  const { check, settings, run, unsaved, notReady } = props
  const t = useT()
  const [originals, setOriginals] = useState(false)
  const [acceptUnreviewed, setAcceptUnreviewed] = useState(false)
  const running = run?.state === 'running'
  const missing = check.missing.length
  const blocked = running || notReady !== null || unsaved > 0
  const needReviewNod = check.unreviewed.length > 0 && !acceptUnreviewed
  const failure = run?.state === 'failed' ? run.failure : null
  const [lastPolicy, setLastPolicy] = useState<MissingPolicy>('block')
  const go = (policy: MissingPolicy, overwrite = false) => {
    setLastPolicy(policy)
    props.onExport(policy, overwrite)
  }

  return (
    <aside className={styles.panel} data-testid="export-preflight">
      <h3 className={styles.panelTitle}>{t('batch.export.check')}</h3>
      <dl className={styles.counts}>
        <Count label={t('batch.export.count.censored')} value={`${check.censored} / ${check.total}`} testId="count-censored" />
        <Count label={t('batch.export.count.reviewed')} value={String(check.reviewed)} testId="count-reviewed" />
        <Count label={t('batch.export.count.missing')} value={String(missing)} tone={missing ? 'warn' : undefined} testId="count-missing" />
        <Count label={t('batch.export.count.unreviewed')} value={String(check.unreviewed.length)} tone={check.unreviewed.length ? 'warn' : undefined} testId="count-unreviewed" />
      </dl>
      <p className={styles.summary} data-tone={settings.metadata_option === 'keep' ? 'danger' : undefined} data-testid="export-meta-summary">
        {t(settings.metadata_option === 'keep' ? 'batch.export.summary.keep' : 'batch.export.summary.removed')}
      </p>
      {unsaved > 0 && <p className={styles.info}>{t('batch.export.unsaved', { n: unsaved })}</p>}

      {missing > 0 && (
        <div className={styles.problem} data-tone="warn" data-testid="preflight-missing">
          <p>{t(failure?.kind === 'missing' ? 'batch.export.missingServer' : 'batch.export.missing', { n: missing })}</p>
          <Names items={check.missing} testId="missing-names" />
          <div className={styles.choices}>
            {props.canCensor && (
              <button type="button" className="btn btn-primary" onClick={props.onGoCensor} data-testid="preflight-censor">
                {t('batch.export.goCensor', { n: missing })}
              </button>
            )}
            <button type="button" className="btn" disabled={blocked || needReviewNod || missing === check.total} onClick={() => go('skip')} data-testid="preflight-skip">
              {t('batch.export.skipThem', { n: check.total - missing })}
            </button>
            <button type="button" className="btn btn-danger" disabled={blocked || needReviewNod} onClick={() => setOriginals(true)} data-testid="preflight-originals">
              {t('batch.export.originals', { n: missing })}
            </button>
          </div>
        </div>
      )}

      {check.unreviewed.length > 0 && (
        <div className={styles.problem} data-tone="warn" data-testid="preflight-unreviewed">
          <p>{t('batch.export.unreviewed', { n: check.unreviewed.length })}</p>
          <Names items={check.unreviewed} testId="unreviewed-names" />
          <label className={styles.check}>
            <input type="checkbox" checked={acceptUnreviewed} onChange={(e) => setAcceptUnreviewed(e.target.checked)} data-testid="preflight-accept-unreviewed" />
            <span>{t('batch.export.acceptUnreviewed')}</span>
          </label>
          {missing === 0 && props.canCensor && (
            <button type="button" className="btn" onClick={props.onGoCensor} data-testid="preflight-review">
              {t('batch.export.goReview')}
            </button>
          )}
        </div>
      )}

      {failure && failure.kind !== 'missing' && <FailureBox failure={failure} running={running} onReplace={() => go(lastPolicy, true)} onGoName={props.onGoName} />}

      {running ? (
        <p className={styles.busy} role="status" data-testid="export-busy">
          {t('batch.export.running', { n: run.count })} <Elapsed started={run.started} />
        </p>
      ) : (
        missing === 0 && (
          <button type="button" className={`btn btn-primary ${styles.exportButton}`} disabled={blocked || needReviewNod || check.total === 0} onClick={() => go('block')} data-testid="export-run">
            {t('batch.export.run', { n: check.total })}
          </button>
        )
      )}
      {notReady && !running && <p className={styles.fieldProblem}>{notReady}</p>}

      {originals && (
        <OriginalsConfirm
          n={missing}
          metadata={settings.metadata_option}
          onCancel={() => setOriginals(false)}
          onOk={() => {
            setOriginals(false)
            go('original')
          }}
        />
      )}
    </aside>
  )
}

function Count({ label, value, tone, testId }: { label: string; value: string; tone?: 'warn'; testId: string }) {
  return (
    <div className={styles.count} data-tone={tone}>
      <dt>{label}</dt>
      <dd className="mono" data-testid={testId}>
        {value}
      </dd>
    </div>
  )
}

function FailureBox({ failure, running, onReplace, onGoName }: { failure: Exclude<ExportFailure, { kind: 'missing' }>; running: boolean; onReplace: () => void; onGoName: () => void }) {
  const t = useT()
  const names = 'names' in failure ? failure.names.join(t('batch.listSep')) : ''
  return (
    <div className={styles.problem} data-tone="danger" role="alert" data-testid="export-failure" data-kind={failure.kind}>
      {failure.kind === 'exists' && (
        <>
          <p>{t('batch.export.fail.exists', { n: failure.names.length, names })}</p>
          <button type="button" className="btn btn-danger" disabled={running} onClick={onReplace} data-testid="export-replace">
            {t('batch.export.replace')}
          </button>
        </>
      )}
      {(failure.kind === 'duplicates' || failure.kind === 'template') && (
        <>
          <p>{failure.kind === 'template' ? t('batch.name.unknownToken', { token: failure.token }) : t('batch.export.fail.duplicates', { names })}</p>
          <button type="button" className="btn" onClick={onGoName}>
            {t('batch.export.goName')}
          </button>
        </>
      )}
      {failure.kind === 'sources' && <p>{t('batch.export.fail.sources', { names })}</p>}
      {failure.kind === 'other' && <p>{t('batch.export.fail.other', { reason: failure.message })}</p>}
    </div>
  )
}

function OriginalsConfirm({ n, metadata, onCancel, onOk }: { n: number; metadata: ExportSettings['metadata_option']; onCancel: () => void; onOk: () => void }) {
  const t = useT()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const footer = (
    <>
      <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onCancel} data-testid="originals-cancel">
        {t('common.cancel')}
      </button>
      <button type="button" className="btn btn-danger" onClick={onOk} data-testid="originals-ok">
        {t('batch.export.originalsOk', { n })}
      </button>
    </>
  )
  return (
    <Dialog title={t('batch.export.originalsTitle', { n })} onClose={onCancel} footer={footer} testId="originals-dialog" initialFocus={cancelRef}>
      <p className={styles.dialogText}>{t('batch.export.originalsBody', { n })}</p>
      <p className={styles.dialogText}>{t(metadata === 'keep' ? 'batch.export.originalsKeep' : 'batch.export.originalsStripped')}</p>
    </Dialog>
  )
}
