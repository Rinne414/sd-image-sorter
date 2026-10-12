import { useEffect, useState } from 'react'
import { useModelStatus, useTaggerModels, type TaggerModel } from '../../api/queries'
import { useT } from '../../i18n'
import { useApp } from '../../state/store'
import { Dialog } from '../../ui/Dialog'
import { TagField } from '../../ui/TagField'
import { describerCard } from '../batch/datasetTagApi'
import { displayTag } from '../batch/edit/tagStyle'
import { AdvancedFields, DescriberFields, MergeField, TaggerSwitch, type DescriberService } from '../batch/TagOptions'
import { useDescriber } from '../settings/ai/aiApi'
import { useAT } from '../settings/ai/aiText'
import { ModelGuideLink } from '../settings/models/ModelGuideLink'
import { CustomModelFields } from './CustomModelFields'
import { GpuNotice, useTagStartPlan } from './GpuNotice'
import styles from './TagDialog.module.css'
import { startTagging } from './tagJob'
import { TaggerList } from './TaggerList'
import {
  clearTagOptions,
  CUSTOM_MODEL,
  CUSTOM_PROFILE_MODEL,
  hasStoredTagOptions,
  isCustom,
  loadTagOptions,
  rememberedThresholds,
  saveTagOptions,
  type CustomPathProblem,
  type RunChoice,
  type TagOptions,
} from './tagOptions'
import { isTagger, readiness, taggerInfo, type ModelCard } from './taggers'

interface Props {
  /** null: every image that has no tags yet (the backend picks them). */
  ids: number[] | null
  count: number
  onClose: () => void
  /** 'describe': opened to write descriptions only (the tagger starts off). */
  mode?: 'tag' | 'describe'
}

const splitTags = (text: string) =>
  text
    .split(/[,\n，]/)
    .map((s) => s.trim())
    .filter(Boolean)

const atDefaults = (o: TagOptions, fallback: string, blacklistText: string) =>
  o.model === fallback &&
  o.threshold === null &&
  o.characterThreshold === null &&
  o.copyrightThreshold === null &&
  o.useGpu &&
  o.maxTags === 0 &&
  o.autoStripNoise &&
  o.mergeStrategy === 'replace' &&
  o.custom.modelPath === '' &&
  o.custom.tagsPath === '' &&
  o.custom.profile === 'wd14' &&
  blacklistText.trim() === ''

/** Why Start cannot be pressed yet, in the panel's words (null: it can). */
function blockReason(o: TagOptions, run: RunChoice): 'dataset.tag.pickOne' | 'dataset.tag.customNoDescribe' | 'dataset.tag.customPathNeeded' | null {
  if (!run.tagger && run.describer === 'off') return 'dataset.tag.pickOne'
  if (run.tagger && isCustom(o) && run.describer !== 'off') return 'dataset.tag.customNoDescribe'
  if (run.tagger && isCustom(o) && o.custom.modelPath.trim() === '') return 'dataset.tag.customPathNeeded'
  return null
}

/** Something this run uses must be downloaded first. */
function needsDownload(o: TagOptions, run: RunChoice, cards: ModelCard[] | undefined): boolean {
  if (!cards) return false
  const tagger = run.tagger && !isCustom(o) ? readiness(taggerInfo(o.model), cards) : 'ready'
  const describer = run.describer === 'florence2' || run.describer === 'toriigate' ? readiness(describerCard(run.describer), cards) : 'ready'
  return [tagger, describer].some((r) => r === 'download' || r === 'check')
}

/** One panel for tagging the picks and/or describing them; the advanced knobs fold away. */
export function TagDialog({ ids, count, onClose, mode = 'tag' }: Props) {
  const t = useT()
  const at = useAT()
  const models = useTaggerModels()
  const status = useModelStatus()
  const describer = useDescriber()
  const plan = useTagStartPlan()
  const [o, setO] = useState<TagOptions | null>(null)
  const [blacklistText, setBlacklistText] = useState('')
  // What this run does is never remembered: the entry point decides (the untagged run always tags).
  const [run, setRun] = useState<RunChoice>({ tagger: mode === 'tag' || ids === null, describer: 'off', toriiLength: 'detailed', grounding: true })
  const [starting, setStarting] = useState(false)
  const [wasReset, setWasReset] = useState(false)
  const [problem, setProblem] = useState<CustomPathProblem | null>(null)

  const list = (models.data?.models ?? []).filter((m) => isTagger(m.name) && !m.disabled)

  useEffect(() => {
    if (o || !models.data) return
    const loaded = loadTagOptions(models.data.default)
    const known = loaded.model === CUSTOM_MODEL || models.data.models.some((m) => m.name === loaded.model && isTagger(m.name) && !m.disabled)
    setO(known ? loaded : { ...loaded, model: models.data.default, threshold: null, characterThreshold: null, copyrightThreshold: null })
    setBlacklistText(loaded.blacklist.join(', '))
  }, [models.data, o])

  const n = count
  const custom = !!o && isCustom(o)
  const current: TaggerModel | undefined = o ? list.find((m) => m.name === (custom ? CUSTOM_PROFILE_MODEL[o.custom.profile] : o.model)) : undefined
  const smart = ids !== null && (run.describer !== 'off' || !run.tagger)
  const reason = o ? blockReason(o, run) : null
  const cards = status.data?.models
  const restart = !!o && run.tagger && !custom && status.isSuccess && readiness(taggerInfo(o.model), cards) === 'restart'

  const edit = (patch: Partial<TagOptions>) => {
    if (o) setO({ ...o, ...patch })
  }
  const editCustom = (value: TagOptions['custom']) => {
    edit({ custom: value })
    setProblem(null)
  }
  const pick = (model: string) => {
    const r = rememberedThresholds(model)
    edit({ model, threshold: r.general, characterThreshold: r.character, copyrightThreshold: r.copyright })
    setWasReset(false)
    setProblem(null)
  }

  // Forget every remembered choice (V4 only): the panel shows the defaults at once.
  const reset = () => {
    if (!models.data) return
    clearTagOptions()
    setO(loadTagOptions(models.data.default))
    setBlacklistText('')
    setProblem(null)
    setWasReset(true)
  }
  const canReset = !!o && (hasStoredTagOptions() || !atDefaults(o, models.data?.default ?? '', blacklistText))

  const go = async () => {
    if (!o) return
    const options = { ...o, blacklist: splitTags(blacklistText) }
    saveTagOptions(options)
    setStarting(true)
    setProblem(null)
    const res = await startTagging(ids, options, count, run)
    setStarting(false)
    if (res.ok) onClose()
    else if (res.problem) setProblem(res.problem)
  }

  const startLabel = (() => {
    if (o && needsDownload(o, run, cards)) return t(run.tagger ? 'tagging.downloadAndStart' : 'dataset.tag.downloadAndDescribe', { n })
    if (!run.tagger) return t('dataset.tag.startDescribe', { n })
    if (run.describer !== 'off') return at('ai.tag.start', { n })
    return plan.mode === 'queue' ? t('signals.tag.queueStart', { n }) : t('tagging.start', { n })
  })()

  const footer = (
    <>
      <span className={styles.footStart}>
        <button type="button" className="btn btn-ghost" onClick={reset} disabled={!canReset} title={t('signals.tag.resetTitle')}>
          {t('signals.tag.reset')}
        </button>
        <span className={styles.resetDone} role="status">
          {wasReset && !canReset ? t('signals.tag.resetDone') : ''}
        </span>
      </span>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void go()} disabled={!o || (run.tagger && !custom && !current) || restart || starting || reason !== null} title={reason ? t(reason) : undefined}>
        {startLabel}
      </button>
    </>
  )

  const title = !run.tagger ? t('dataset.tag.describeTitle', { n }) : t(ids ? 'tagging.title' : 'tagging.titleUntagged', { n })

  return (
    <Dialog title={title} onClose={onClose} footer={footer} testId="tag-dialog" wide>
      {run.tagger && <p className={styles.lead}>{ids ? t('tagging.retagAll', { n }) : t('tagging.untaggedLead')}</p>}
      {models.isError && <p className={styles.error}>{t('error.generic', { reason: models.error.message })}</p>}
      {models.isPending && <p className={styles.lead}>{t('picker.loading')}</p>}
      <GpuNotice plan={plan} />
      {ids && <TaggerSwitch on={run.tagger} set={(tagger) => setRun({ ...run, tagger })} />}
      {run.tagger && (
        <>
          <ModelGuideLink card="wd14" onGo={onClose} />
          <TaggerList list={list} chosen={o?.model ?? null} cards={cards} statusKnown={status.isSuccess} onPick={pick} />
          {o && custom && <CustomModelFields value={o.custom} set={editCustom} problem={problem} />}
        </>
      )}
      {ids && o && (
        <DescribeArea o={o} run={run} setRun={setRun} cards={cards} vlm={describer} count={n} blacklist={splitTags(blacklistText).length > 0} locked={run.tagger && custom} onSetup={onClose} edit={edit} />
      )}
      {reason && (
        <p className={styles.reason} role="status" data-testid="tag-reason">
          {t(reason)}
        </p>
      )}
      {o && run.tagger && (current || custom) && (
        <div className={styles.advanced}>
          <AdvancedFields o={o} set={edit} current={current} smart={smart}>
            <label className={`${styles.field} ${styles.wideField}`}>
              <span>{t('tagging.blacklist')}</span>
              {/* The tagger's vocabulary, written as library tags are (the backend ignores underscores here). */}
              <TagField value={blacklistText} placeholder="watermark, signature" onChange={setBlacklistText} write={displayTag} testId="tag-blacklist" />
              <small className={styles.warn}>{t('tagging.blacklistWarn')}</small>
            </label>
          </AdvancedFields>
        </div>
      )}
    </Dialog>
  )
}

interface DescribeProps {
  o: TagOptions
  run: RunChoice
  setRun: (run: RunChoice) => void
  cards: ModelCard[] | undefined
  vlm: DescriberService | null
  count: number
  /** The panel has tags to drop, which a Smart Tag run cannot do. */
  blacklist: boolean
  locked: boolean
  onSetup: () => void
  edit: (patch: Partial<TagOptions>) => void
}

/** Who describes the picks, what it costs, and what happens to descriptions they already have. */
function DescribeArea({ o, run, setRun, cards, vlm, count, blacklist, locked, onSetup, edit }: DescribeProps) {
  const t = useT()
  const at = useAT()
  const describing = run.describer !== 'off'
  const setup = () => {
    onSetup()
    useApp.getState().openSettings('ai')
  }
  return (
    <div className={styles.describe} data-testid="tag-describe">
      <DescriberFields o={run} set={setRun} cards={cards} vlm={vlm} taggerOn={run.tagger} locked={locked} onSetup={setup}>
        {run.describer === 'vlm' && vlm?.ready && (
          <p className={vlm.local ? styles.hint : styles.calls} role="status" data-testid="tag-describe-calls">
            {t(vlm.local ? 'dataset.tag.callsLocal' : 'dataset.tag.callsPaid', { n: count, name: vlm.label })}
          </p>
        )}
        {describing && <MergeField value={o.mergeStrategy} set={(mergeStrategy) => edit({ mergeStrategy })} tagsReplaced={run.tagger} />}
        {describing && run.tagger && blacklist && <p className={styles.warnLine}>{at('ai.tag.blacklistOff')}</p>}
      </DescriberFields>
    </div>
  )
}
