import { create } from 'zustand'
import { useModelStatus } from '../../../api/queries'
import { useT } from '../../../i18n'
import { isFinished } from '../../jobs/progress'
import { useJobs } from '../../jobs/jobs'
import styles from '../check/CheckStep.module.css'
import { ENGINES, startAutoMaskAll, useMaskStatus, withEngine, type MaskEngine } from './maskApi'
import { openMaskEditor } from './MaskEditor'

/** The automatic-mask choices, shared by this card and the check list's "mask these" (V3.5: Lucida for many). */
export const useMaskOptions = create<{ engine: MaskEngine; overwrite: boolean }>(() => ({ engine: 'lucida', overwrite: false }))

const useMasking = () => useJobs((s) => s.jobs.some((j) => j.kind === 'masks' && !isFinished(j.progress.status)))

/** Mask these Library images automatically (downloading the engine first when needed). */
export function autoMaskImages(ids: readonly number[]): void {
  const { engine, overwrite } = useMaskOptions.getState()
  void withEngine(engine, () => void startAutoMaskAll(ids, engine, overwrite))
}

interface Props {
  ids: readonly number[]
  folderCount: number
}

/** Training masks in the check step: how many images have one, masking them all, editing one by one. */
export function MaskCard({ ids, folderCount }: Props) {
  const t = useT()
  const status = useMaskStatus(ids)
  const { engine, overwrite } = useMaskOptions()
  const masking = useMasking()
  const card = useModelStatus().data?.models.find((c) => c.id === engine)
  const missing = !!card && card.status !== 'ready' && card.status !== 'needs_restart'
  const masked = status.data
  const without = masked ? ids.filter((id) => !masked.has(id)) : []
  const targets = overwrite ? ids : without
  const firstWithout = without[0] ?? ids[0]

  return (
    <section className={styles.block} data-testid="check-masks">
      <h2 className={styles.blockTitle}>{t('dataset.masks.title')}</h2>
      <p className={styles.note}>{t('dataset.masks.what')}</p>
      {folderCount > 0 && <p className={styles.sourceNa}>{t('dataset.check.notForFolder', { n: folderCount })}</p>}
      {ids.length === 0 ? (
        <p className={styles.hint}>{t('dataset.masks.noLibrary')}</p>
      ) : (
        <>
          <p className={styles.note} data-testid="mask-coverage">
            {status.isError
              ? t('dataset.check.failed', { reason: status.error.message })
              : masked
                ? t('dataset.masks.coverage', { n: masked.size, total: ids.length })
                : t('grid.loading')}
          </p>
          <label className={styles.field}>
            <span>{t('dataset.masks.engine')}</span>
            <select
              className={styles.select}
              value={engine}
              onChange={(e) => useMaskOptions.setState({ engine: e.target.value as MaskEngine })}
              data-testid="mask-all-engine"
            >
              {(Object.keys(ENGINES) as MaskEngine[]).map((id) => (
                <option key={id} value={id}>
                  {ENGINES[id].label}
                </option>
              ))}
            </select>
          </label>
          {engine === 'lucida' && <p className={styles.hint}>{t('dataset.masks.lucidaNote')}</p>}
          <label className={styles.check}>
            <input type="checkbox" checked={overwrite} onChange={(e) => useMaskOptions.setState({ overwrite: e.target.checked })} />
            {t('dataset.masks.overwrite')}
          </label>
          <div className={styles.issueActions}>
            <button type="button" className="btn" disabled={masking || !masked || targets.length === 0} onClick={() => autoMaskImages(targets)} data-testid="mask-all">
              {masking
                ? t('dataset.masks.allBusy')
                : missing
                  ? t('dataset.masks.allDownload', { name: ENGINES[engine].label, size: ENGINES[engine].size, n: targets.length })
                  : t('dataset.masks.all', { n: targets.length })}
            </button>
            <button type="button" className="btn" onClick={() => firstWithout !== undefined && openMaskEditor(ids, firstWithout)} data-testid="mask-edit">
              {t('dataset.masks.edit')}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
