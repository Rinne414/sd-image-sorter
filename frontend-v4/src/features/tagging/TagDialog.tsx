import { useEffect, useState } from 'react'
import { useModelStatus, useTaggerModels } from '../../api/queries'
import { useT } from '../../i18n'
import { Dialog } from '../../ui/Dialog'
import styles from './TagDialog.module.css'
import { loadTagOptions, rememberedThresholds, saveTagOptions, startTagging, type TagOptions } from './tagJob'
import { isTagger, readiness, taggerInfo, type Readiness, type TaggerInfo } from './taggers'

interface Props {
  /** null: every image that has no tags yet (the backend picks them). */
  ids: number[] | null
  count: number
  onClose: () => void
}

const parseUnit = (text: string): number | null => {
  if (text.trim() === '') return null
  const n = Number(text)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null
}

const splitTags = (text: string) =>
  text
    .split(/[,\n，]/)
    .map((s) => s.trim())
    .filter(Boolean)

/** One panel for tagging the picks: which tagger, then (rarely) the advanced knobs. */
export function TagDialog({ ids, count, onClose }: Props) {
  const t = useT()
  const models = useTaggerModels()
  const status = useModelStatus()
  const [o, setO] = useState<TagOptions | null>(null)
  const [blacklistText, setBlacklistText] = useState('')
  const [starting, setStarting] = useState(false)

  const list = (models.data?.models ?? []).filter((m) => isTagger(m.name) && !m.disabled)

  useEffect(() => {
    if (o || !models.data) return
    const loaded = loadTagOptions(models.data.default)
    const known = models.data.models.some((m) => m.name === loaded.model && isTagger(m.name) && !m.disabled)
    setO(known ? loaded : { ...loaded, model: models.data.default, threshold: null, characterThreshold: null })
    setBlacklistText(loaded.blacklist.join(', '))
  }, [models.data, o])

  const n = count
  const current = list.find((m) => m.name === o?.model)
  const info = o ? taggerInfo(o.model) : null
  // Until the status arrives (it takes about a second) nothing is claimed about downloads.
  const statusKnown = status.isSuccess
  const state: Readiness | null = info && statusKnown ? readiness(info, status.data.models) : null

  const pick = (model: string) => {
    if (!o) return
    const r = rememberedThresholds(model)
    setO({ ...o, model, threshold: r.general, characterThreshold: r.character })
  }

  const go = async () => {
    if (!o) return
    const options = { ...o, blacklist: splitTags(blacklistText) }
    saveTagOptions(options)
    setStarting(true)
    const ok = await startTagging(ids, options, count)
    setStarting(false)
    if (ok) onClose()
  }

  const stateText = (r: Readiness, inf: TaggerInfo) => {
    if (!statusKnown) return t('tagging.checking')
    switch (r) {
      case 'ready':
        return t('tagging.ready')
      case 'download':
        return inf.sizeHint ? t('tagging.download', { size: inf.sizeHint }) : t('tagging.downloadUnknown')
      case 'check':
        return t('tagging.check')
      case 'restart':
        return t('tagging.restart')
    }
  }

  const startLabel =
    state === 'download' || state === 'check'
      ? t('tagging.downloadAndStart', { n })
      : t('tagging.start', { n })

  const footer = (
    <>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button type="button" className="btn btn-primary" onClick={() => void go()} disabled={!o || !current || state === 'restart' || starting}>
        {startLabel}
      </button>
    </>
  )

  return (
    <Dialog title={t(ids ? 'tagging.title' : 'tagging.titleUntagged', { n })} onClose={onClose} footer={footer} testId="tag-dialog" wide>
      <p className={styles.lead}>{ids ? t('tagging.retagAll', { n }) : t('tagging.untaggedLead')}</p>
      {models.isError && <p className={styles.error}>{t('error.generic', { reason: models.error.message })}</p>}
      {models.isPending && <p className={styles.lead}>{t('picker.loading')}</p>}
      <div className={styles.list} role="radiogroup" aria-label={t('tagging.tagger')}>
        {list.map((m) => {
          const inf = taggerInfo(m.name)
          const r = readiness(inf, status.data?.models)
          const checked = o?.model === m.name
          return (
            <label key={m.name} className={styles.row} data-checked={checked || undefined}>
              <input type="radio" name="tagger" checked={checked} onChange={() => pick(m.name)} />
              <span className={styles.name}>
                {inf.label}
                {m.recommended && <span className={styles.badge}>{t('tagging.recommended')}</span>}
              </span>
              <span className={styles.note}>{t(inf.note)}</span>
              <span className={styles.state} data-state={statusKnown ? r : 'checking'}>
                {stateText(r, inf)}
              </span>
            </label>
          )
        })}
      </div>

      {o && current && (
        <details
          className={styles.advanced}
          onToggle={(e) => {
            if (e.currentTarget.open) e.currentTarget.scrollIntoView({ block: 'nearest' })
          }}
        >
          <summary>{t('tagging.advanced')}</summary>
          <div className={styles.fields}>
            <label className={styles.field}>
              <span>{t('tagging.threshold')}</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={o.threshold ?? ''}
                placeholder={String(current.default_threshold)}
                onChange={(e) => setO({ ...o, threshold: parseUnit(e.target.value) })}
              />
              <small>{t('tagging.thresholdHint', { n: current.default_threshold })}</small>
            </label>
            <label className={styles.field}>
              <span>{t('tagging.characterThreshold')}</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={o.characterThreshold ?? ''}
                placeholder={String(current.default_character_threshold)}
                onChange={(e) => setO({ ...o, characterThreshold: parseUnit(e.target.value) })}
              />
              <small>{t('tagging.thresholdHint', { n: current.default_character_threshold })}</small>
            </label>
            <label className={styles.field}>
              <span>{t('tagging.maxTags')}</span>
              <input
                type="number"
                min={0}
                max={2000}
                step={1}
                value={o.maxTags || ''}
                placeholder={t('tagging.maxTagsNone')}
                onChange={(e) => setO({ ...o, maxTags: Math.max(0, Math.min(2000, Math.round(Number(e.target.value) || 0))) })}
              />
              <small>{t('tagging.maxTagsHint', { n: current.default_max_tags_per_image })}</small>
            </label>
            <label className={styles.check}>
              <input type="checkbox" checked={o.useGpu} onChange={(e) => setO({ ...o, useGpu: e.target.checked })} />
              <span>{t('tagging.useGpu')}</span>
            </label>
            <label className={`${styles.field} ${styles.wideField}`}>
              <span>{t('tagging.blacklist')}</span>
              <input
                type="text"
                value={blacklistText}
                placeholder="watermark, signature"
                spellCheck={false}
                onChange={(e) => setBlacklistText(e.target.value)}
              />
              <small className={styles.warn}>{t('tagging.blacklistWarn')}</small>
            </label>
          </div>
        </details>
      )}
    </Dialog>
  )
}
