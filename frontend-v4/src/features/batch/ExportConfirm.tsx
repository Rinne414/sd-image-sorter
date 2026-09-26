import { useRef, useState } from 'react'
import type { Batch } from '../../api/types'
import { useT } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import { useNamePreview } from './exportApi'
import { namesBody, type ExportSettings } from './exportSettings'
import styles from './ExportStep.module.css'
import { nameBlock } from './names'

interface Props {
  batch: Batch
  settings: ExportSettings
  /** How the images without a censored copy are handled. */
  policy: 'skip' | 'original'
  /** Images without a censored copy. */
  missing: number
  onCancel: () => void
  /** `when`: the moment these names were made; the export writes exactly them. */
  onOk: (when: Date) => void
}

/**
 * The last word before an export that treats images without a censored copy
 * differently: the exact files it will write, from the server's name preview
 * with the same policy. Leaving images out closes up the numbers, so these can
 * differ from the Name step's list; exporting originals marks them.
 */
export function ExportConfirm({ batch, settings, policy, missing, onCancel, onOk }: Props) {
  const t = useT()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [when] = useState(() => new Date())
  const { preview, stale } = useNamePreview(batch, namesBody(settings, policy, when))
  const block = nameBlock(preview, stale)
  const rows = (preview?.items ?? []).filter((row) => row.included)
  const leftOut = (preview?.items ?? []).filter((row) => !row.included)
  const danger = policy === 'original'

  const footer = (
    <>
      <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onCancel} data-testid="confirm-cancel">
        {t('common.cancel')}
      </button>
      <button type="button" className={danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={() => onOk(when)} disabled={block !== null} data-testid="confirm-ok">
        {danger ? t('batch.export.originalsOk', { n: missing }) : t('batch.export.confirmSkipOk', { n: rows.length })}
      </button>
    </>
  )

  return (
    <Dialog
      title={danger ? t('batch.export.originalsTitle', { n: missing }) : t('batch.export.confirmSkipTitle', { n: missing })}
      onClose={onCancel}
      footer={footer}
      testId="export-confirm"
      initialFocus={cancelRef}
      wide
    >
      <div data-policy={policy} data-testid="export-confirm-body">
        {danger ? (
          <>
            <p className={styles.dialogText}>{t('batch.export.originalsBody', { n: missing })}</p>
            <p className={styles.dialogText}>{t(settings.metadata_option === 'keep' ? 'batch.export.originalsKeep' : 'batch.export.originalsStripped')}</p>
            <p className={styles.dialogText}>{t('batch.export.confirmFiles')}</p>
          </>
        ) : (
          <p className={styles.dialogText}>{t('batch.export.confirmSkipBody', { n: missing })}</p>
        )}
        {block === 'pending' && !preview ? (
          <p className={styles.info}>{t('batch.export.confirmPending')}</p>
        ) : (
          <ol className={styles.confirmList} data-testid="confirm-names">
            {rows.map((row) => (
              <li key={row.image_id} className={styles.confirmRow} data-source={row.source} data-testid="confirm-row">
                <span className={`${styles.confirmName} mono`} data-testid="confirm-name">
                  {row.output_name}
                </span>
                <span className={`${styles.confirmFrom} mono`}>{row.filename}</span>
                {row.source !== 'censored' && <span className={styles.confirmOriginal}>{t('batch.export.confirmOriginal')}</span>}
              </li>
            ))}
          </ol>
        )}
        {leftOut.length > 0 && (
          <p className={styles.info} data-testid="confirm-left-out">
            {t('batch.export.confirmLeftOut', { names: leftOut.map((row) => row.filename).join(t('batch.listSep')) })}
          </p>
        )}
        {block === 'template' && <p className={styles.fieldProblem}>{t('batch.name.unknownToken', { token: preview?.template_error?.token ?? '' })}</p>}
        {block === 'duplicates' && (
          <p className={styles.fieldProblem}>{t('batch.export.fail.duplicates', { names: (preview?.duplicates ?? []).map((d) => d.output_name).join(t('batch.listSep')) })}</p>
        )}
      </div>
    </Dialog>
  )
}
