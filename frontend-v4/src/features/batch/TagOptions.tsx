import { rememberedThresholds } from '../tagging/tagJob'
import { readiness, taggerInfo, type ModelCard, type Readiness } from '../tagging/taggers'
import type { TaggerModel } from '../../api/queries'
import { useT, type MessageKey } from '../../i18n'
import { describerCard, type VlmStatus } from './datasetTagApi'
import type { Describer, TagStepOptions } from './datasetTag'
import styles from './TagStep.module.css'

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

interface Props {
  o: TagStepOptions
  set: (o: TagStepOptions) => void
  models: TaggerModel[]
  cards: ModelCard[] | undefined
  vlm: VlmStatus | undefined
}

function readyText(t: ReturnType<typeof useT>, model: string, cards: ModelCard[] | undefined): string {
  if (!cards) return t('tagging.checking')
  const info = taggerInfo(model)
  const r = readiness(info, cards)
  return r === 'download' && info.sizeHint ? t('tagging.download', { size: info.sizeHint }) : t(READY[r])
}

/** Which tagger, and (folded away) its thresholds and a second tagger that votes. */
export function TaggerFields({ o, set, models, cards }: Omit<Props, 'vlm'>) {
  const t = useT()
  const current = models.find((m) => m.name === o.model)
  const pick = (model: string) => {
    const r = rememberedThresholds(model)
    set({ ...o, model, threshold: r.general, characterThreshold: r.character, secondModel: o.secondModel === model ? null : o.secondModel })
  }
  return (
    <section className={styles.block} aria-labelledby="tag-tagger">
      <h3 id="tag-tagger" className={styles.blockTitle}>
        {t('dataset.tag.tagger')}
      </h3>
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
      <details className={styles.more}>
        <summary>{t('tagging.advanced')}</summary>
        <div className={styles.grid}>
          <label className={styles.field}>
            <span>{t('tagging.threshold')}</span>
            <input type="number" min={0} max={1} step={0.01} value={o.threshold ?? ''} placeholder={String(current?.default_threshold ?? '')} onChange={(e) => set({ ...o, threshold: parseUnit(e.target.value) })} />
          </label>
          <label className={styles.field}>
            <span>{t('tagging.characterThreshold')}</span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={o.characterThreshold ?? ''}
              placeholder={String(current?.default_character_threshold ?? '')}
              onChange={(e) => set({ ...o, characterThreshold: parseUnit(e.target.value) })}
            />
          </label>
          <label className={styles.field}>
            <span>{t('tagging.maxTags')}</span>
            <input
              type="number"
              min={0}
              max={2000}
              value={o.maxTags || ''}
              placeholder={t('tagging.maxTagsNone')}
              onChange={(e) => set({ ...o, maxTags: Math.max(0, Math.min(2000, Math.round(Number(e.target.value) || 0))) })}
            />
          </label>
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
          <label className={styles.check}>
            <input type="checkbox" checked={o.useGpu} onChange={(e) => set({ ...o, useGpu: e.target.checked })} />
            {t('tagging.useGpu')}
          </label>
        </div>
      </details>
    </section>
  )
}

/** Whether a description is added, and by whom (off by default). */
export function DescriberFields({ o, set, cards, vlm }: Omit<Props, 'models'>) {
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
    const r = cards ? readiness({ ...card, note: 'tagger.note.custom' }, cards) : null
    const state = r === null ? t('tagging.checking') : r === 'download' ? t('tagging.download', { size: card.sizeHint }) : t(READY[r])
    return t(`dataset.tag.${d}Note` as MessageKey, { state })
  }
  const vlmNote = !vlm ? t('tagging.checking') : vlm.configured ? t(vlm.local ? 'dataset.tag.vlmLocal' : 'dataset.tag.vlmPaid', { name: vlm.label }) : t('dataset.tag.vlmMissing')
  return (
    <section className={styles.block} aria-labelledby="tag-describe">
      <h3 id="tag-describe" className={styles.blockTitle}>
        {t('dataset.tag.describe')}
      </h3>
      <p className={styles.hint}>{t('dataset.tag.describeLead')}</p>
      <div className={styles.choices} role="radiogroup" aria-labelledby="tag-describe" data-testid="tag-describer">
        {option('off', t('dataset.tag.describeOff'), t('dataset.tag.describeOffNote'))}
        {option('vlm', t('dataset.tag.describeVlm'), vlmNote, !vlm?.configured)}
        {option('florence2', 'Florence-2', local('florence2'))}
        {option('toriigate', 'ToriiGate', local('toriigate'))}
      </div>
      {o.describer === 'toriigate' && (
        <label className={styles.field}>
          <span>{t('dataset.tag.toriiLength')}</span>
          <select value={o.toriiLength} onChange={(e) => set({ ...o, toriiLength: e.target.value === 'brief' ? 'brief' : 'detailed' })}>
            <option value="detailed">{t('dataset.tag.toriiDetailed')}</option>
            <option value="brief">{t('dataset.tag.toriiBrief')}</option>
          </select>
        </label>
      )}
      {o.describer !== 'off' && (
        <label className={styles.check}>
          <input type="checkbox" checked={o.grounding} onChange={(e) => set({ ...o, grounding: e.target.checked })} />
          {t('dataset.tag.grounding')}
        </label>
      )}
    </section>
  )
}
