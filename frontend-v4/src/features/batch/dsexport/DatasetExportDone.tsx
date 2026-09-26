import { useT } from '../../../i18n'
import { copyText } from '../../../lib/format'
import { useApp } from '../../../state/store'
import { useToasts } from '../../../ui/toasts'
import { openFolderPath } from '../../library/fileActions'
import type { Entry } from '../entries'
import pix from '../ExportStep.module.css'
import styles from './DatasetExport.module.css'
import { fileName, groupIssues, type DatasetExportResult, type ReadinessIssue } from './report'
import { LABEL_KEY } from './texts'

/** Rows of the file table; the full list is in the folder and in export_manifest.json. */
const MAX_ROWS = 300

interface Props {
  result: DatasetExportResult
  warnings: ReadinessIssue[]
  entries: readonly Entry[]
  onAgain: () => void
}

function title(result: DatasetExportResult, t: ReturnType<typeof useT>): string {
  if (result.status === 'cancelled') return t('dataset.export.done.cancelled', { n: result.exported })
  if (result.status === 'failed') return t('dataset.export.done.failed')
  if (result.error_count > 0) return t('dataset.export.done.partial', { n: result.exported, failed: result.error_count })
  return t('dataset.export.done.ok', { n: result.exported })
}

/** What the export wrote, where, what failed and why; opens the folder. */
export function DatasetExportDone({ result, warnings, entries, onAgain }: Props) {
  const t = useT()
  const toast = useToasts((s) => s.push)
  const folder = result.output_folder
  const errors = [...result.error_messages, ...result.warnings.map((w) => `${w.message} (${w.backup_path})`)]
  const skipped = result.items.filter((i) => i.skipped_reason)
  const written = result.items.filter((i) => i.dst_caption_path && !i.error && !i.skipped_reason)

  const copyPath = async () => {
    const ok = await copyText(folder)
    toast(ok ? t('batch.result.copied') : t('batch.result.copyFailed'), ok ? 'info' : 'error')
  }

  return (
    <section className={pix.result} data-testid="ds-export-result" data-status={result.status}>
      <header className={pix.resultHead}>
        <h2 className={pix.resultTitle}>{title(result, t)}</h2>
        {folder && (
          <p className={`${pix.resultPath} mono`} data-testid="ds-result-folder">
            {folder}
          </p>
        )}
        <div className={pix.resultActions}>
          {folder && (
            <>
              <button type="button" className="btn" onClick={() => void openFolderPath(folder)} data-testid="ds-result-open">
                {t('batch.result.open')}
              </button>
              <button type="button" className="btn" onClick={() => void copyPath()} data-testid="ds-result-copy">
                {t('batch.result.copyPath')}
              </button>
            </>
          )}
          <span className={pix.gap} />
          <button type="button" className="btn" onClick={onAgain} data-testid="ds-result-again">
            {t('batch.result.again')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => useApp.getState().setPage('batch')} data-testid="ds-result-done">
            {t('batch.result.toList')}
          </button>
        </div>
        <div className={styles.lines}>
          {result.trainer_config_path && (
            <span data-testid="ds-result-config">
              {t('dataset.export.done.config')} <b className="mono">{fileName(result.trainer_config_path)}</b>
            </span>
          )}
          {result.masks_written + result.masks_missing > 0 && <span>{t('dataset.export.done.masks', { n: result.masks_written, missing: result.masks_missing })}</span>}
          {result.package_status !== 'not_requested' && (
            <span className={result.package_status === 'complete' ? styles.ok : undefined}>{t(result.package_status === 'complete' ? 'dataset.export.done.packageOk' : 'dataset.export.done.packageIncomplete')}</span>
          )}
        </div>
      </header>

      {errors.length > 0 && (
        <div className={pix.problem} data-tone="danger" data-testid="ds-result-errors">
          <p>{t('dataset.export.done.errors', { n: errors.length })}</p>
          <ul className={pix.names}>
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {skipped.length > 0 && (
        <div className={pix.problem} data-testid="ds-result-skipped">
          <p>{t('dataset.export.done.skipped', { n: result.skipped })}</p>
          <ul className={pix.names}>
            {skipped.map((i) => (
              <li key={`${i.image_id}-${i.src_image_path}`}>
                <span className="mono">{fileName(i.src_image_path ?? '')}</span> — {i.skipped_reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && <Warnings warnings={warnings} entries={entries} />}

      <table className={pix.table} data-testid="ds-result-files">
        <thead>
          <tr>
            <th>#</th>
            <th>{t('dataset.export.done.colImage')}</th>
            <th>{t('dataset.export.done.colCaption')}</th>
            <th>{t('dataset.export.done.colFrom')}</th>
          </tr>
        </thead>
        <tbody>
          {written.slice(0, MAX_ROWS).map((i, n) => (
            <tr key={`${i.image_id}-${i.dst_caption_path}`} data-testid="ds-result-row">
              <td className="mono">{n + 1}</td>
              <td className="mono">{i.dst_image_path ? fileName(i.dst_image_path) : '—'}</td>
              <td className="mono">{fileName(i.dst_caption_path ?? '')}</td>
              <td className={pix.notes}>{fileName(i.src_image_path ?? '')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(written.length > MAX_ROWS || result.items_truncated) && <p className={pix.info}>{t('dataset.export.done.moreRows', { n: result.total_items })}</p>}
    </section>
  )
}

function Warnings({ warnings, entries }: { warnings: ReadinessIssue[]; entries: readonly Entry[] }) {
  const t = useT()
  return (
    <div className={pix.problem} data-testid="ds-result-warnings">
      <p>{t('dataset.export.done.warnings')}</p>
      <ul className={pix.names}>
        {groupIssues(warnings, entries).map((g) => (
          <li key={g.label} title={g.detail}>
            {t(LABEL_KEY[g.label])} · {g.names.slice(0, 6).join(t('batch.listSep')) || g.count}
          </li>
        ))}
      </ul>
    </div>
  )
}
