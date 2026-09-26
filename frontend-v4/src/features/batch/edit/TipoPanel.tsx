import { useState } from 'react'
import { useModelStatus } from '../../../api/queries'
import { useT } from '../../../i18n'
import { Icon } from '../../../ui/Icon'
import styles from './CaptionPanel.module.css'
import { loadTipoModel, saveTipoModel, suggestUpsample, TIPO_MODELS, tipoInstalled, type TipoModel, type TipoProposal } from './tagAids'
import { displayTag } from './tagStyle'

interface Props {
  tags: readonly string[]
  imageId: number | null
  disabled: boolean
  onAdd: (tags: string[]) => void
  onClose: () => void
}

type Ask = { state: 'idle' } | { state: 'busy' } | { state: 'done'; proposals: TipoProposal[] } | { state: 'failed'; reason: string }

/**
 * TIPO proposes tags the tagger has no label for. Nothing is applied: the
 * user ticks what goes into this caption. A model that is not on disk yet is
 * named with its size first; the first run downloads it.
 */
export function TipoPanel({ tags, imageId, disabled, onAdd, onClose }: Props) {
  const t = useT()
  const status = useModelStatus()
  const [model, setModel] = useState<TipoModel>(loadTipoModel)
  const [ask, setAsk] = useState<Ask>({ state: 'idle' })
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const installed = tipoInstalled(status.data?.models, model)
  const size = TIPO_MODELS.find((m) => m.id === model)?.size ?? ''

  const run = async () => {
    setAsk({ state: 'busy' })
    setPicked(new Set())
    try {
      setAsk({ state: 'done', proposals: await suggestUpsample(tags, model, imageId) })
    } catch (error) {
      setAsk({ state: 'failed', reason: (error as Error).message })
    }
  }
  const toggle = (tag: string) => setPicked((p) => (p.has(tag) ? new Set([...p].filter((x) => x !== tag)) : new Set([...p, tag])))

  return (
    <section className={styles.tool} aria-label={t('dataset.edit.tipoTitle')} data-testid="edit-tipo">
      <header className={styles.infoHead}>
        <span className={styles.label}>{t('dataset.edit.tipoTitle')}</span>
        <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
          <Icon name="close" size={12} />
        </button>
      </header>
      <p className={styles.muted}>{t('dataset.edit.tipoLead')}</p>
      <div className={styles.toolRow}>
        <select
          className={styles.select}
          value={model}
          aria-label={t('dataset.edit.tipoModel')}
          onChange={(e) => {
            const next = e.target.value as TipoModel
            setModel(next)
            saveTipoModel(next)
          }}
        >
          {TIPO_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id} · {m.size}
            </option>
          ))}
        </select>
        <button type="button" className="btn" onClick={() => void run()} disabled={ask.state === 'busy' || tags.length === 0} data-testid="edit-tipo-run">
          {installed ? t('dataset.edit.tipoRun') : t('dataset.edit.tipoDownloadRun', { size })}
        </button>
      </div>
      {!installed && status.data && <p className={styles.warnText}>{t('dataset.edit.tipoNotInstalled', { size })}</p>}
      {tags.length === 0 && <p className={styles.muted}>{t('dataset.edit.tipoNoTags')}</p>}
      <TipoResult ask={ask} picked={picked} toggle={toggle} />
      {ask.state === 'done' && ask.proposals.length > 0 && (
        <button type="button" className="btn btn-primary" disabled={disabled || picked.size === 0} onClick={() => onAdd([...picked])} data-testid="edit-tipo-add">
          {t('dataset.edit.tipoAdd', { n: picked.size })}
        </button>
      )}
    </section>
  )
}

function TipoResult({ ask, picked, toggle }: { ask: Ask; picked: ReadonlySet<string>; toggle: (tag: string) => void }) {
  const t = useT()
  if (ask.state === 'busy') return <p className={styles.muted}>{t('dataset.edit.tipoBusy')}</p>
  if (ask.state === 'failed') return <p className={styles.problem}>{t('dataset.edit.tipoFailed', { reason: ask.reason })}</p>
  if (ask.state !== 'done') return null
  if (ask.proposals.length === 0) return <p className={styles.muted}>{t('dataset.edit.tipoNone')}</p>
  return (
    <ul className={styles.proposals}>
      {ask.proposals.map((p) => (
        <li key={p.tag}>
          <label className={`chip cat-${p.category} ${styles.proposal}`}>
            <input type="checkbox" checked={picked.has(p.tag)} onChange={() => toggle(p.tag)} data-testid="edit-tipo-pick" />
            {displayTag(p.tag)}
          </label>
        </li>
      ))}
    </ul>
  )
}
