import { useState, type ReactNode, type SyntheticEvent } from 'react'
import { loadAdvancedOpen, rememberedThresholds, saveAdvancedOpen, type MergeStrategy } from '../tagging/tagOptions'
import { readiness, taggerInfo, type ModelCard, type Readiness } from '../tagging/taggers'
import type { TaggerModel } from '../../api/queries'
import { useT, type MessageKey } from '../../i18n'
import { describerCard } from './datasetTagApi'
import type { Describer, TagStepOptions } from './datasetTag'
import styles from './TagStep.module.css'

// The tag panel's parts, shared by the Library's tag panel and a dataset
// batch's tag step so both offer the same choices with the same words:
// the tagger switch, 高级设置 (remembered open or closed), the describer,
// and what a run does to captions an image already has.

const READY: Record<Readiness, MessageKey> = {
  ready: 'tagging.ready',
  download: 'tagging.downloadUnknown',
  check: 'tagging.check',
  restart: 'tagging.restart',
}

const parseUnit = (text: string): number | null => {
  if (text.trim() === '') return null
  const n = Number(text)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null
}

function readyText(t: ReturnType<typeof useT>, model: string, cards: ModelCard[] | undefined): string {
  if (!cards) return t('tagging.checking')
  const info = taggerInfo(model)
  const r = readiness(info, cards)
  return r === 'download' && info.sizeHint ? t('tagging.download', { size: info.sizeHint }) : t(READY[r])
}

/** The describing service as the panels need it (null/undefined: not read yet). */
export interface DescriberService {
  ready: boolean
  /** Runs on this computer, so calls cost nothing. */
  local: boolean
  label: string
}

/** Whether the booru tagger runs; off, the panel says the tags stay as they are. */
export function TaggerSwitch({ on, set }: { on: boolean; set: (on: boolean) => void }) {
  const t = useT()
  return (
    <div className={styles.switch}>
      <label className={styles.check}>
        <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} data-testid="tag-tagger-on" />
        {t('dataset.tag.taggerOn')}
      </label>
      {!on && (
        <p className={styles.note} role="status" data-testid="tag-tagger-off">
          {t('dataset.tag.taggerOff')}
        </p>
      )}
    </div>
  )
}

/** 高级设置 open or closed; remembered for both panels. */
function useAdvancedOpen() {
  const [open, setOpen] = useState(loadAdvancedOpen)
  const onToggle = (e: SyntheticEvent<HTMLDetailsElement>) => {
    const now = e.currentTarget.open
    if (now === open) return
    setOpen(now)
    saveAdvancedOpen(now)
    if (now) e.currentTarget.scrollIntoView({ block: 'nearest' })
  }
  return { open, onToggle }
}

/** What 高级设置 edits in both panels. */
export interface AdvancedValues {
  threshold: number | null
  characterThreshold: number | null
  copyrightThreshold: number | null
  maxTags: number
  useGpu: boolean
  autoStripNoise: boolean
}

type ThresholdKey = 'threshold' | 'characterThreshold' | 'copyrightThreshold'

interface AdvancedProps {
  o: AdvancedValues
  set: (patch: Partial<AdvancedValues>) => void
  /** The chosen tagger (its defaults are the placeholders). */
  current: TaggerModel | undefined
  /** A Smart Tag run: the copyright threshold and the noise switch apply. */
  smart: boolean
  /** The panel's own fields (a second tagger, a drop list). */
  children?: ReactNode
}

/** The tagger's thresholds, tag limit, GPU and noise switch, folded away. */
export function AdvancedFields({ o, set, current, smart, children }: AdvancedProps) {
  const t = useT()
  const { open, onToggle } = useAdvancedOpen()
  const threshold = (label: MessageKey, key: ThresholdKey, fallback: number | null | undefined) => (
    <label className={styles.field}>
      <span>{t(label)}</span>
      <input type="number" min={0} max={1} step={0.01} value={o[key] ?? ''} placeholder={String(fallback ?? '')} onChange={(e) => set({ [key]: parseUnit(e.target.value) })} />
      {fallback != null && <small>{t('tagging.thresholdHint', { n: fallback })}</small>}
    </label>
  )
  return (
    <details className={styles.more} open={open} onToggle={onToggle} data-testid="tag-advanced">
      <summary>{t('tagging.advanced')}</summary>
      <div className={styles.grid}>
        {threshold('tagging.threshold', 'threshold', current?.default_threshold)}
        {threshold('tagging.characterThreshold', 'characterThreshold', current?.default_character_threshold)}
        {smart && threshold('dataset.tag.copyrightThreshold', 'copyrightThreshold', current?.default_copyright_threshold ?? current?.default_threshold)}
        <label className={styles.field}>
          <span>{t('tagging.maxTags')}</span>
          <input
            type="number"
            min={0}
            max={2000}
            step={1}
            value={o.maxTags || ''}
            placeholder={t('tagging.maxTagsNone')}
            onChange={(e) => set({ maxTags: Math.max(0, Math.min(2000, Math.round(Number(e.target.value) || 0))) })}
          />
          {current && <small>{t('tagging.maxTagsHint', { n: current.default_max_tags_per_image })}</small>}
        </label>
        {children}
        <label className={styles.check}>
          <input type="checkbox" checked={o.useGpu} onChange={(e) => set({ useGpu: e.target.checked })} />
          {t('tagging.useGpu')}
        </label>
        {smart && (
          <label className={styles.check}>
            <input type="checkbox" checked={o.autoStripNoise} onChange={(e) => set({ autoStripNoise: e.target.checked })} data-testid="tag-strip-noise" />
            {t('dataset.tag.stripNoise')}
          </label>
        )}
      </div>
    </details>
  )
}

/** Replace or add to a caption or description an image already has. */
export function MergeField({ value, set, tagsReplaced }: { value: MergeStrategy; set: (v: MergeStrategy) => void; tagsReplaced: boolean }) {
  const t = useT()
  return (
    <label className={styles.field}>
      <span>{t('dataset.tag.merge')}</span>
      <select value={value} onChange={(e) => set(e.target.value === 'append' ? 'append' : 'replace')} data-testid="tag-merge">
        <option value="replace">{t('dataset.tag.mergeReplace')}</option>
        <option value="append">{t('dataset.tag.mergeAppend')}</option>
      </select>
      {value === 'append' && tagsReplaced && <small>{t('dataset.tag.mergeTagsNote')}</small>}
    </label>
  )
}

interface TaggerProps {
  o: TagStepOptions
  set: (o: TagStepOptions) => void
  models: TaggerModel[]
  cards: ModelCard[] | undefined
}

/** Which tagger (or none), and (folded away) its thresholds and a second tagger that votes. */
export function TaggerFields({ o, set, models, cards }: TaggerProps) {
  const t = useT()
  const current = models.find((m) => m.name === o.model)
  const pick = (model: string) => {
    const r = rememberedThresholds(model)
    set({ ...o, model, threshold: r.general, characterThreshold: r.character, copyrightThreshold: r.copyright, secondModel: o.secondModel === model ? null : o.secondModel })
  }
  return (
    <section className={styles.block} aria-labelledby="tag-tagger">
      <h3 id="tag-tagger" className={styles.blockTitle}>
        {t('dataset.tag.tagger')}
      </h3>
      <TaggerSwitch on={o.tagger} set={(tagger) => set({ ...o, tagger })} />
      {o.tagger && (
        <>
          <label className={styles.field}>
            <select value={o.model} onChange={(e) => pick(e.target.value)} aria-labelledby="tag-tagger" data-testid="tag-model">
              {models.map((m) => (
                <option key={m.name} value={m.name}>
                  {taggerInfo(m.name).label}
                  {m.recommended ? ` · ${t('tagging.recommended')}` : ''}
                </option>
              ))}
            </select>
            <span className={styles.hint}>
              {t(taggerInfo(o.model).note)} · <span data-testid="tag-model-state">{readyText(t, o.model, cards)}</span>
            </span>
          </label>
          <AdvancedFields o={o} set={(patch) => set({ ...o, ...patch })} current={current} smart>
            <SecondTagger o={o} set={set} models={models} />
          </AdvancedFields>
        </>
      )}
    </section>
  )
}

function SecondTagger({ o, set, models }: Omit<TaggerProps, 'cards'>) {
  const t = useT()
  return (
    <>
      <label className={styles.field}>
        <span>{t('dataset.tag.second')}</span>
        <select value={o.secondModel ?? ''} onChange={(e) => set({ ...o, secondModel: e.target.value || null })} data-testid="tag-second">
          <option value="">{t('dataset.tag.secondNone')}</option>
          {models
            .filter((m) => m.name !== o.model)
            .map((m) => (
              <option key={m.name} value={m.name}>
                {taggerInfo(m.name).label}
              </option>
            ))}
        </select>
      </label>
      {o.secondModel && (
        <div className={styles.field} role="radiogroup" aria-label={t('dataset.tag.agreement')}>
          <span>{t('dataset.tag.agreement')}</span>
          <label className={styles.check}>
            <input type="radio" name="agreement" checked={o.agreement === 'any'} onChange={() => set({ ...o, agreement: 'any' })} />
            {t('dataset.tag.agreeAny')}
          </label>
          <label className={styles.check}>
            <input type="radio" name="agreement" checked={o.agreement === 'both'} onChange={() => set({ ...o, agreement: 'both' })} />
            {t('dataset.tag.agreeBoth')}
          </label>
        </div>
      )}
    </>
  )
}

/** Who describes, and how: the part of a run's choices the describer section edits. */
export interface DescribeChoice {
  describer: Describer
  toriiLength: 'brief' | 'detailed'
  grounding: boolean
}

interface DescriberProps<T extends DescribeChoice> {
  o: T
  set: (o: T) => void
  cards: ModelCard[] | undefined
  vlm: DescriberService | null | undefined
  /** The tagger runs too (grounding needs its tags; "none" then means tags only). */
  taggerOn: boolean
  /** Only "none" can be chosen (a custom model tags on its own). */
  locked?: boolean
  /** Go and set up a VLM service (shown while none is ready). */
  onSetup?: () => void
  children?: ReactNode
}

/** Whether a description is added, and by whom (off by default). */
export function DescriberFields<T extends DescribeChoice>({ o, set, cards, vlm, taggerOn, locked = false, onSetup, children }: DescriberProps<T>) {
  const t = useT()
  const option = (value: Describer, label: string, note: string, disabled = false) => (
    <label className={styles.choice} data-checked={o.describer === value || undefined} data-disabled={disabled || undefined}>
      <input type="radio" name="describer" value={value} checked={o.describer === value} disabled={disabled} onChange={() => set({ ...o, describer: value })} />
      <span className={styles.choiceName}>{label}</span>
      <span className={styles.hint}>{note}</span>
    </label>
  )
  const local = (d: 'florence2' | 'toriigate') => {
    const card = describerCard(d)
    const r = cards ? readiness(card, cards) : null
    const state = r === null ? t('tagging.checking') : r === 'download' ? t('tagging.download', { size: card.sizeHint }) : t(READY[r])
    return t(`dataset.tag.${d}Note` as MessageKey, { state })
  }
  const vlmNote = !vlm ? t('tagging.checking') : vlm.ready ? t(vlm.local ? 'dataset.tag.vlmLocal' : 'dataset.tag.vlmPaid', { name: vlm.label }) : t('dataset.tag.vlmMissing')
  return (
    <section className={styles.block} aria-labelledby="tag-describe">
      <h3 id="tag-describe" className={styles.blockTitle}>
        {t('dataset.tag.describe')}
      </h3>
      <p className={styles.hint}>{t(taggerOn ? 'dataset.tag.describeLead' : 'dataset.tag.describeLeadOnly')}</p>
      <div className={styles.choices} role="radiogroup" aria-labelledby="tag-describe" data-testid="tag-describer">
        {option('off', t('dataset.tag.describeOff'), t(taggerOn ? 'dataset.tag.describeOffNote' : 'dataset.tag.describeOffIdle'))}
        {option('vlm', t('dataset.tag.describeVlm'), vlmNote, locked || !vlm?.ready)}
        {option('florence2', 'Florence-2', local('florence2'), locked)}
        {option('toriigate', 'ToriiGate', local('toriigate'), locked)}
      </div>
      {vlm && !vlm.ready && onSetup && (
        <button type="button" className={styles.link} onClick={onSetup} data-testid="tag-describe-setup">
          {t('dataset.tag.vlmSetup')} →
        </button>
      )}
      {o.describer === 'toriigate' && (
        <label className={styles.field}>
          <span>{t('dataset.tag.toriiLength')}</span>
          <select value={o.toriiLength} onChange={(e) => set({ ...o, toriiLength: e.target.value === 'brief' ? 'brief' : 'detailed' })}>
            <option value="detailed">{t('dataset.tag.toriiDetailed')}</option>
            <option value="brief">{t('dataset.tag.toriiBrief')}</option>
          </select>
        </label>
      )}
      {o.describer !== 'off' && taggerOn && (
        <label className={styles.check}>
          <input type="checkbox" checked={o.grounding} onChange={(e) => set({ ...o, grounding: e.target.checked })} />
          {t('dataset.tag.grounding')}
        </label>
      )}
      {children}
    </section>
  )
}
