import { useEffect, useId, useRef, useState } from 'react'
import styles from './Ai.module.css'
import { useAT, type AiKey } from './aiText'
import type { VlmSettings } from './types'
import type { VlmDraft } from './useVlmDraft'
import { NUMBER_FIELDS, type VlmForm } from './vlmForm'

interface AdvancedProps {
  draft: VlmDraft
  busy: boolean
  probing: boolean
  onProbe: () => void
  /** The label of the number the last save refused, to mark it. */
  invalid: AiKey | null
}

/** Retries, timeout, concurrency (and finding its limit), tokens, temperature, image size, the NSFW retry prompt. */
export function AdvancedFields({ draft, busy, probing, onProbe, invalid }: AdvancedProps) {
  const t = useAT()
  const nsfwId = useId()
  const fold = useRef<HTMLDetailsElement>(null)
  const { form, set } = draft
  // a number the save refused is shown open; the user folds it again
  useEffect(() => {
    if (invalid && fold.current) fold.current.open = true
  }, [invalid])
  return (
    <details ref={fold} className={styles.fold} data-testid="vlm-advanced">
      <summary>{t('ai.adv')}</summary>
      <div className={styles.foldBody}>
        <div className={styles.numbers}>
          {NUMBER_FIELDS.map((f) => (
            <NumberInput key={f.key} label={t(f.label)} value={form[f.key]} min={f.min} max={f.max} step={f.whole ? 1 : 0.1} invalid={invalid === f.label} onChange={(v) => set({ [f.key]: v })} testId={`vlm-${f.key}`} />
          ))}
        </div>
        <div className={styles.row}>
          <button type="button" className="btn" onClick={onProbe} disabled={busy} data-testid="vlm-probe">
            {t(probing ? 'ai.adv.probing' : 'ai.adv.probe')}
          </button>
        </div>
        <p className={styles.hint}>{t('ai.adv.probeHint')}</p>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={nsfwId}>
            {t('ai.adv.nsfwRetry')}
          </label>
          <textarea id={nsfwId} className={styles.textarea} rows={2} value={form.nsfwRetryPrompt} onChange={(e) => set({ nsfwRetryPrompt: e.target.value })} data-testid="vlm-nsfw" />
          <p className={styles.hint}>{t('ai.adv.nsfwRetryHint')}</p>
        </div>
      </div>
    </details>
  )
}

interface NumberProps {
  label: string
  value: string
  min: number
  max: number
  step: number
  invalid: boolean
  onChange: (value: string) => void
  testId: string
}

function NumberInput({ label, value, min, max, step, invalid, onChange, testId }: NumberProps) {
  const id = useId()
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={`${styles.input} ${styles.number} mono`}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
    </div>
  )
}

/** The proxy for reaching the service (HTTP, HTTPS, SOCKS), folded unless one is set. */
export function ProxyFields({ draft }: { draft: VlmDraft }) {
  const t = useAT()
  const { form, set } = draft
  const on = !!(form.httpProxy.trim() || form.httpsProxy.trim() || form.socksProxy.trim())
  const rows: { key: 'httpProxy' | 'httpsProxy' | 'socksProxy'; label: AiKey; example: string }[] = [
    { key: 'httpProxy', label: 'ai.proxy.http', example: 'http://127.0.0.1:7890' },
    { key: 'httpsProxy', label: 'ai.proxy.https', example: 'http://127.0.0.1:7890' },
    { key: 'socksProxy', label: 'ai.proxy.socks', example: 'socks5://127.0.0.1:1080' },
  ]
  return (
    <details className={styles.fold} data-testid="vlm-proxy">
      <summary>
        {t('ai.proxy')}
        {on && <span className={styles.badge}>{t('ai.proxy.on')}</span>}
      </summary>
      <div className={styles.foldBody}>
        <p className={styles.hint}>
          {t('ai.proxy.hint')}
        </p>
        {rows.map((r) => (
          <TextInput key={r.key} label={t(r.label)} value={form[r.key]} placeholder={r.example} onChange={(v) => set({ [r.key]: v } as Partial<VlmForm>)} testId={`vlm-${r.key}`} />
        ))}
      </div>
    </details>
  )
}

function TextInput({ label, value, placeholder, onChange, testId }: { label: string; value: string; placeholder?: string; onChange: (v: string) => void; testId: string }) {
  const id = useId()
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={`${styles.input} mono`}
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
    </div>
  )
}

/** Gemini through Vertex AI with a service account; shown for Gemini only. */
export function VertexFields({ draft, settings }: { draft: VlmDraft; settings: VlmSettings }) {
  const t = useAT()
  const jsonId = useId()
  const fold = useRef<HTMLDetailsElement>(null)
  const { form, set } = draft
  const hasAccount = !!settings.service_account_json_display
  // open at first when Vertex is in use; after that the user decides
  const [openAtFirst] = useState(form.useVertex)
  useEffect(() => {
    if (openAtFirst && fold.current) fold.current.open = true
  }, [openAtFirst])
  return (
    <details ref={fold} className={styles.fold} data-testid="vlm-vertex">
      <summary>
        {t('ai.vertex')}
        {form.useVertex && <span className={styles.badge}>{t('ai.vertex.on')}</span>}
      </summary>
      <div className={styles.foldBody}>
        <label className={styles.check}>
          <input type="checkbox" checked={form.useVertex} onChange={(e) => set({ useVertex: e.target.checked })} data-testid="vlm-use-vertex" />
          {t('ai.vertex.use')}
        </label>
        <TextInput label={t('ai.vertex.project')} value={form.vertexProject} onChange={(v) => set({ vertexProject: v })} testId="vlm-vertex-project" />
        <TextInput label={t('ai.vertex.location')} value={form.vertexLocation} placeholder="us-central1" onChange={(v) => set({ vertexLocation: v })} testId="vlm-vertex-location" />
        <div className={styles.field}>
          <label className={styles.label} htmlFor={jsonId}>
            {t('ai.vertex.json')}
          </label>
          <textarea
            id={jsonId}
            className={`${styles.textarea} mono`}
            rows={4}
            spellCheck={false}
            autoComplete="off"
            placeholder={hasAccount ? t('ai.key.placeholderSaved') : '{ "type": "service_account", … }'}
            value={form.serviceAccountJson}
            onChange={(e) => set({ serviceAccountJson: e.target.value })}
            data-testid="vlm-vertex-json"
          />
          <p className={styles.hint}>{t(hasAccount ? 'ai.vertex.jsonSaved' : 'ai.vertex.jsonNone')}</p>
        </div>
      </div>
    </details>
  )
}
