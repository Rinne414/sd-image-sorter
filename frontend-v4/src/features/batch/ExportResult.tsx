import { api, unwrap } from '../../api/client'
import { useT } from '../../i18n'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import type { ExportResult as Result } from './exportApi'
import styles from './ExportStep.module.css'

interface Props {
  result: Result
  onAgain: () => void
}

/** What the export wrote: every file, from which picture, and whether generation data is gone. */
export function ExportResult({ result, onAgain }: Props) {
  const t = useT()
  const toast = useToasts((s) => s.push)
  const done = result.exported.length
  // The file manager can only be opened on a library image; an export into a scanned folder has one.
  const inLibrary = result.exported.find((file) => file.reconciled_image_id !== null)?.reconciled_image_id ?? null

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(result.output_folder)
      toast(t('batch.result.copied'))
    } catch {
      toast(t('batch.result.copyFailed'), 'error')
    }
  }

  const openFolder = async () => {
    if (inLibrary === null) return
    try {
      unwrap(await api.POST('/api/open-folder', { body: { image_id: inLibrary } }))
    } catch (error) {
      toast(t('error.generic', { reason: (error as Error).message }), 'error')
    }
  }

  return (
    <section className={styles.result} data-testid="export-result" data-success={result.success || undefined}>
      <header className={styles.resultHead}>
        <h2 className={styles.resultTitle}>
          {result.errors.length > 0 ? t('batch.result.partial', { n: done, failed: result.errors.length }) : t('batch.result.done', { n: done })}
        </h2>
        <p className={`${styles.resultPath} mono`} data-testid="result-folder">
          {result.output_folder}
        </p>
        <div className={styles.resultActions}>
          <button type="button" className="btn" onClick={() => void copyPath()} data-testid="result-copy">
            {t('batch.result.copyPath')}
          </button>
          {inLibrary !== null && (
            <button type="button" className="btn" onClick={() => void openFolder()} data-testid="result-open">
              {t('batch.result.open')}
            </button>
          )}
          <span className={styles.gap} />
          <button type="button" className="btn" onClick={onAgain} data-testid="result-again">
            {t('batch.result.again')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => useApp.getState().setPage('batch')} data-testid="result-done">
            {t('batch.result.toList')}
          </button>
        </div>
      </header>

      {result.errors.length > 0 && (
        <div className={styles.problem} data-tone="danger" data-testid="result-errors">
          <p>{t('batch.result.errors', { n: result.errors.length })}</p>
          <ul className={styles.names}>
            {result.errors.map((error) => (
              <li key={`${error.image_id}-${error.filename}`}>
                <span className="mono">{error.filename}</span> — {error.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      <table className={styles.table} data-testid="result-files">
        <thead>
          <tr>
            <th>#</th>
            <th>{t('batch.result.col.file')}</th>
            <th>{t('batch.result.col.from')}</th>
            <th>{t('batch.result.col.meta')}</th>
            <th>{t('batch.result.col.notes')}</th>
          </tr>
        </thead>
        <tbody>
          {result.exported.map((file, i) => (
            <tr key={file.output_name} data-testid="result-row" data-source={file.source}>
              <td className="mono">{i + 1}</td>
              <td className="mono" title={file.output_path}>
                {file.output_name}
                <span className={styles.from}>{file.filename}</span>
              </td>
              <td data-tone={file.source === 'original' ? 'danger' : 'ok'}>{t(file.source === 'original' ? 'batch.result.original' : 'batch.result.censored')}</td>
              <td data-tone={file.generation_data_removed ? 'ok' : 'danger'} data-testid="result-meta">
                {t(file.generation_data_removed ? 'batch.result.removed' : 'batch.result.kept')}
              </td>
              <td className={styles.notes}>
                {[file.watermarked && t('batch.result.watermarked'), file.overwrote_existing && t('batch.result.replaced'), ...file.warnings].filter(Boolean).join(t('batch.listSep'))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {result.skipped.length > 0 && (
        <p className={styles.info} data-testid="result-skipped">
          {t('batch.result.skipped', { n: result.skipped.length, names: result.skipped.map((s) => s.filename).join(t('batch.listSep')) })}
        </p>
      )}
      {result.caption_file && <p className={styles.info}>{t('batch.result.caption', { name: result.caption_file })}</p>}
    </section>
  )
}
