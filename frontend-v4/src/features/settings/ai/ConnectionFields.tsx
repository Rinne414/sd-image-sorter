import { useId, useState } from 'react'
import styles from './Ai.module.css'
import { useAT } from './aiText'
import type { Provider, VlmSettings } from './types'
import type { VlmDraft } from './useVlmDraft'
import { PROVIDERS } from './vlmForm'

/** A long list gets a filter box. */
const FILTER_FROM = 20

interface Props {
  draft: VlmDraft
  settings: VlmSettings
  busy: boolean
  fetching: boolean
  /** null: not fetched yet. */
  models: string[] | null
  onFetch: () => void
  /** The service type the backend just recognised from the address. */
  detected: Provider | null
}

/** Where the service is, which kind it is, its key and the model. */
export function ConnectionFields({ draft, settings, busy, fetching, models, onFetch, detected }: Props) {
  const t = useAT()
  const endpointId = useId()
  const providerId = useId()
  const keyId = useId()
  const modelId = useId()
  const { form, set } = draft
  const hasKey = !!settings.api_key_display

  return (
    <div className={styles.group}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={endpointId}>
          {t('ai.endpoint')}
        </label>
        <input
          id={endpointId}
          className={`${styles.input} mono`}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://api.openai.com/v1"
          value={form.endpoint}
          onChange={(e) => set({ endpoint: e.target.value })}
          data-testid="vlm-endpoint"
        />
        <p className={styles.hint}>{t('ai.endpoint.hint')}</p>
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={providerId}>
          {t('ai.provider')}
        </label>
        <select id={providerId} className={styles.select} value={form.provider} onChange={(e) => set({ provider: e.target.value as Provider })} data-testid="vlm-provider">
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {t(`ai.provider.${p}`)}
            </option>
          ))}
        </select>
        <p className={styles.hint} role="status" data-testid="vlm-detected">
          {detected ? t('ai.provider.detected', { name: t(`ai.provider.${detected}`) }) : ''}
        </p>
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={keyId}>
          {t('ai.key')}
        </label>
        <input
          id={keyId}
          className={`${styles.input} mono`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={t(hasKey ? 'ai.key.placeholderSaved' : 'ai.key.placeholder')}
          value={form.apiKey}
          onChange={(e) => set({ apiKey: e.target.value })}
          data-testid="vlm-key"
        />
        <p className={styles.hint} data-testid="vlm-key-state">
          {t(hasKey ? 'ai.key.saved' : 'ai.key.none')}
        </p>
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={modelId}>
          {t('ai.model')}
        </label>
        <div className={styles.inline}>
          <input
            id={modelId}
            className={`${styles.input} mono`}
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('ai.model.placeholder')}
            value={form.model}
            onChange={(e) => set({ model: e.target.value })}
            data-testid="vlm-model"
          />
          <button type="button" className="btn" onClick={onFetch} disabled={busy} data-testid="vlm-fetch-models">
            {t(fetching ? 'ai.model.fetching' : 'ai.model.fetch')}
          </button>
        </div>
        <p className={styles.hint}>{t('ai.free')}</p>
        {models && <ModelList models={models} current={form.model} onPick={(model) => set({ model })} />}
      </div>
    </div>
  )
}

function ModelList({ models, current, onPick }: { models: string[]; current: string; onPick: (model: string) => void }) {
  const t = useAT()
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  if (models.length === 0) {
    return (
      <p className={styles.note} data-tone="info" role="status" data-testid="vlm-models-none">
        {t('ai.model.none')}
      </p>
    )
  }
  const needle = filter.trim().toLowerCase()
  const shown = needle ? models.filter((m) => m.toLowerCase().includes(needle)) : models
  return (
    <div data-testid="vlm-models">
      <p className={styles.note} data-tone="info" role="status">
        {picked ? t('ai.model.picked', { model: picked }) : t('ai.model.found', { n: models.length })}
      </p>
      {models.length > FILTER_FROM && (
        <input
          className={`${styles.input} ${styles.filter} mono`}
          type="search"
          aria-label={t('ai.model.filter')}
          placeholder={t('ai.model.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      {shown.length === 0 ? (
        <p className={styles.hint}>{t('ai.model.noMatch', { text: filter.trim() })}</p>
      ) : (
        <div className={styles.models}>
          {shown.map((m) => (
            <button
              key={m}
              type="button"
              className={`${styles.modelPick} mono`}
              aria-pressed={m === current}
              title={m}
              onClick={() => {
                onPick(m)
                setPicked(m)
              }}
            >
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
