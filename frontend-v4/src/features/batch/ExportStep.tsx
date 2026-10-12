import type { Batch } from '../../api/types'
import { useT } from '../../i18n'
import { useCensorPanel } from '../censor/panel'
import { isDirty, keyOf, rememberImage, useCensorSession } from '../censor/session'
import { patchBatch } from './batchApi'
import { clearExportRun, runExport, useExportRuns } from './exportApi'
import { exportBody, watermarkProblem, type ExportSettings, type MissingPolicy } from './exportSettings'
import { ExportForm } from './ExportForm'
import { ExportResult } from './ExportResult'
import styles from './ExportStep.module.css'
import { PreflightPanel } from './PreflightPanel'
import { firstToFix, preflight, withServerMissing } from './preflight'
import { StepBar } from './StepBar'
import { flushExportSettings, useExportSettings } from './useExportSettings'

/** Censor edits of this batch that are saving or not saved: the export waits for them. */
function useUnsavedCensor(batch: Batch): number {
  return useCensorSession((s) =>
    batch.items.reduce((n, item) => {
      const edit = s.edits[keyOf(batch.id, item.image_id)]
      return edit && (edit.saving || isDirty(edit)) ? n + 1 : n
    }, 0),
  )
}

function notReadyReason(settings: ExportSettings, t: ReturnType<typeof useT>): string | null {
  if (!settings.output_folder.trim()) return t('batch.export.needFolder')
  if (watermarkProblem(settings.watermark)) return t('batch.export.wm.needText')
  return null
}

interface Props {
  batch: Batch
  onGo: (step: string) => void
}

/**
 * The Pixiv export: generation data removed by default, each image's censored
 * copy used automatically; images without one are named and the user decides
 * (censor them, leave them out, or export their originals after a second confirm).
 */
export function ExportStep({ batch, onGo }: Props) {
  const t = useT()
  const [settings, update] = useExportSettings(batch)
  const run = useExportRuns((s) => s.runs[batch.id])
  const unsaved = useUnsavedCensor(batch)
  const serverMissing = run?.state === 'failed' && run.failure.kind === 'missing' ? run.failure.ids : []
  const check = withServerMissing(preflight(batch.items), batch.items, serverMissing)
  const censorStep = batch.steps.find((step) => step.id === 'censor')

  const start = (policy: MissingPolicy, overwrite = false, when = new Date()) => {
    flushExportSettings(batch.id)
    const count = policy === 'skip' ? check.total - check.missing.length : check.total
    void runExport(batch.id, count, exportBody(overwrite ? { ...settings, overwrite: true } : settings, policy, when))
  }

  const goCensor = () => {
    const fix = firstToFix(check)
    if (fix) rememberImage(batch.id, fix.imageId)
    useCensorPanel.getState().setTab(fix?.review ? 'review' : 'brush')
    if (censorStep && !censorStep.enabled) {
      void patchBatch(batch.id, { steps: batch.steps.map((step) => (step.id === 'censor' ? { ...step, enabled: true } : step)), current_step: 'censor' })
    } else onGo('censor')
  }

  if (run?.state === 'done') return <ExportResult result={run.result} onAgain={() => clearExportRun(batch.id)} />

  return (
    <section className={styles.step} data-testid="export-step">
      <StepBar count={t('batch.pick.count', { n: batch.items.length })} hint={t('batch.export.hint')} />
      <div className={styles.body}>
        <div className={styles.formScroll}>
          <ExportForm settings={settings} update={update} disabled={run?.state === 'running'} />
        </div>
        <PreflightPanel
          batch={batch}
          check={check}
          settings={settings}
          run={run}
          unsaved={unsaved}
          notReady={notReadyReason(settings, t)}
          canCensor={censorStep !== undefined}
          onExport={start}
          onGoCensor={goCensor}
          onGoName={() => onGo('name')}
        />
      </div>
    </section>
  )
}
