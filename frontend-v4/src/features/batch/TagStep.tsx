import { useEffect, useMemo, useState } from 'react'
import { useModelStatus, useTaggerModels } from '../../api/queries'
import type { Batch } from '../../api/types'
import { useT } from '../../i18n'
import { isFinished } from '../jobs/progress'
import { useJobs } from '../jobs/jobs'
import { loadTagOptions, saveTagOptions } from '../tagging/tagOptions'
import { isTagger } from '../tagging/taggers'
import { useApp } from '../../state/store'
import { useBatchProject } from './datasetApi'
import { formFromSettings, readBatchDataset } from './datasetSettings'
import { tagScope, type TagStepOptions } from './datasetTag'
import { resumeTagRun, startDatasetTagging, syncAiCaptions, useProjectHeads, useVlmStatus } from './datasetTagApi'
import { stepLabel } from './labels'
import { RethresholdPanel } from './RethresholdPanel'
import { StepBar } from './StepBar'
import { RunReport, ScopeBox } from './TagScope'
import { DescriberFields, TaggerFields } from './TagOptions'
import styles from './TagStep.module.css'
import { useBatchEntries } from './useBatchEntries'

interface Props {
  batch: Batch
  next: string | null
  onNext: (step: string) => void
}

/** The step's choices: the saved tagger defaults, no description (D29), only images without tags. */
function initialOptions(fallbackModel: string, known: (name: string) => boolean): TagStepOptions {
  const saved = loadTagOptions(fallbackModel)
  const ok = known(saved.model)
  return {
    model: ok ? saved.model : fallbackModel,
    threshold: ok ? saved.threshold : null,
    characterThreshold: ok ? saved.characterThreshold : null,
    copyrightThreshold: ok ? saved.copyrightThreshold : null,
    maxTags: saved.maxTags,
    useGpu: saved.useGpu,
    secondModel: null,
    agreement: 'any',
    describer: 'off',
    toriiLength: 'detailed',
    grounding: true,
    retagExisting: false,
    tagger: true,
    autoStripNoise: saved.autoStripNoise,
    mergeStrategy: saved.mergeStrategy,
  }
}

/** The step's choices as the tag panel remembers them (the drop list and a custom file stay as they were). */
function remember(o: TagStepOptions): void {
  const kept = { ...loadTagOptions(o.model), autoStripNoise: o.autoStripNoise, mergeStrategy: o.mergeStrategy }
  // With the tagger off its choices were not in use: they stay as remembered.
  if (!o.tagger) {
    saveTagOptions(kept)
    return
  }
  const { model, threshold, characterThreshold, copyrightThreshold, useGpu, maxTags } = o
  saveTagOptions({ ...kept, model, threshold, characterThreshold, copyrightThreshold, useGpu, maxTags })
}

const useRunning = () => useJobs((s) => s.jobs.some((j) => j.kind === 'smarttag' && !isFinished(j.progress.status)))

/** A dataset batch's tag step: a tagger, an optional description, the counts, then Smart Tag. */
export function TagStep({ batch, next, onNext }: Props) {
  const t = useT()
  const { entries } = useBatchEntries(batch)
  const view = useBatchProject(batch).data
  const heads = useProjectHeads(view)
  const taggers = useTaggerModels()
  const status = useModelStatus()
  const vlmStatus = useVlmStatus().data
  const vlm = vlmStatus && { ready: vlmStatus.configured, local: vlmStatus.local, label: vlmStatus.label }
  const running = useRunning()
  const [o, setO] = useState<TagStepOptions | null>(null)
  const [starting, setStarting] = useState(false)
  // The tag blacklist is set in the Library's tag dialog; a run and new thresholds honour it.
  const [blacklist] = useState(() => loadTagOptions('').blacklist)

  // A run started before a reload still ends here.
  useEffect(() => {
    void resumeTagRun(batch)
  }, [batch])

  const models = useMemo(() => (taggers.data?.models ?? []).filter((m) => isTagger(m.name) && !m.disabled), [taggers.data])
  useEffect(() => {
    if (o || !taggers.data) return
    setO(initialOptions(taggers.data.default, (name) => models.some((m) => m.name === name)))
  }, [taggers.data, models, o])

  const tagged = useMemo(() => new Set((view?.library_images ?? []).filter((row) => row.tagged).map((row) => row.id)), [view])
  const scope = useMemo(() => (o && heads.data ? tagScope(entries, tagged, heads.data, o.retagExisting) : null), [entries, tagged, heads.data, o])
  const maxTags = o?.maxTags ?? 0
  const filters = useMemo(() => ({ blacklist, maxTags }), [blacklist, maxTags])
  const libraryIds = useMemo(() => entries.flatMap((e) => (e.imageId === null ? [] : [e.imageId])), [entries])
  const folderCount = entries.length - libraryIds.length

  const start = async () => {
    if (!o || !scope || !view) return
    remember(o)
    const form = formFromSettings(view.project.settings, readBatchDataset(batch.settings))
    setStarting(true)
    await startDatasetTagging(batch, o, scope, form.purpose, form.targetModel)
    setStarting(false)
  }

  return (
    <section className={styles.step} data-testid="tag-step">
      <StepBar count={t('batch.pick.count', { n: entries.length })} hint={t('dataset.tag.hint')}>
        {next && (
          <button type="button" className="btn" onClick={() => onNext(next)} data-testid="step-next">
            {t('batch.panel.next', { step: stepLabel(next, t) })}
          </button>
        )}
      </StepBar>
      <div className={styles.scroller}>
        {!o || !scope ? (
          <p className={styles.hint}>{taggers.isError || heads.isError ? t('dataset.tag.loadFailed') : t('grid.loading')}</p>
        ) : (
          <div className={styles.layout}>
            <div className={styles.column}>
              <TaggerFields o={o} set={setO} models={models} cards={status.data?.models} />
              <DescriberFields o={o} set={setO} cards={status.data?.models} vlm={vlm} taggerOn={o.tagger} onSetup={() => useApp.getState().openSettings('ai')} />
            </div>
            <div className={styles.column}>
              <ScopeBox o={o} set={setO} scope={scope} vlm={vlm} busy={starting || running} running={running} onStart={() => void start()} />
              <RunReport batch={batch} entries={entries} scope={scope} model={o.model} running={running} />
              <RethresholdPanel
                ids={libraryIds}
                folderCount={folderCount}
                filters={filters}
                defaultFor={(name) => models.find((m) => m.name === name)?.default_threshold}
                onApplied={(model) => void syncAiCaptions(batch, model)}
              />
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
