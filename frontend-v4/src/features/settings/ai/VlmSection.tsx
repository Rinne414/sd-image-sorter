import { useEffect, useState } from 'react'
import { Section } from '../about/Section'
import { useSaved } from '../useSaved'
import styles from './Ai.module.css'
import { detectProvider, fetchModels, probeConcurrency, saveVlmSettings, testConnection } from './aiApi'
import { useAT, type AiKey } from './aiText'
import { ConnectionFields } from './ConnectionFields'
import { AdvancedFields, ProxyFields, VertexFields } from './MoreFields'
import { PromptFields } from './PromptFields'
import type { Provider, VlmSettings } from './types'
import type { VlmDraft } from './useVlmDraft'
import { NUMBER_FIELDS, PROVIDERS, settingsBody, testOutcome, vlmReadiness, withDetectedProvider, type FormError, type VlmForm } from './vlmForm'

type Busy = 'save' | 'test' | 'fetch' | 'probe'
type Note = { text: string; tone: 'ok' | 'error' | 'info' }

/** Wait this long after typing before asking which service an address is. */
const DETECT_MS = 400
const CONCURRENT = NUMBER_FIELDS.find((f) => f.key === 'concurrent')
/** The probe ramps to at least this many (or the current setting, when higher). */
const PROBE_FROM = 8

const hostOf = (endpoint: string) => {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}

/** The VLM service: where, which, key, model, prompts, the rarer settings, then Save / Test connection. */
export function VlmSection({ draft, settings }: { draft: VlmDraft; settings: VlmSettings }) {
  const t = useAT()
  const [busy, setBusy] = useState<Busy | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [invalid, setInvalid] = useState<AiKey | null>(null)
  const [models, setModels] = useState<string[] | null>(null)
  const [justSaved, markSaved] = useSaved<'vlm'>()
  const detected = useDetectedProvider(draft)
  const { form } = draft

  const formError = (e: FormError) => (e.key === 'ai.range' ? t('ai.range', { field: t(e.field), min: e.min, max: e.max }) : t(e.key))
  const hasAddress = (f: VlmForm) => f.endpoint.trim() !== '' || (f.provider === 'gemini' && f.useVertex)

  /** Save the whole form; false (with the reason shown) when it could not be. */
  const save = async (): Promise<boolean> => {
    const built = settingsBody(form)
    if (!built.ok) {
      setInvalid(built.error.key === 'ai.range' ? built.error.field : null)
      setNote({ text: formError(built.error), tone: 'error' })
      return false
    }
    setInvalid(null)
    try {
      await saveVlmSettings(built.body)
      draft.saved(form)
      markSaved('vlm')
      return true
    } catch (error) {
      setNote({ text: t('ai.saveFailed', { reason: (error as Error).message }), tone: 'error' })
      return false
    }
  }

  /** Save first (the backend works from what is stored), then do `then`. */
  const act = async (kind: Busy, then?: () => Promise<Note | null>) => {
    if (kind !== 'save' && !hasAddress(form)) {
      setNote({ text: t('ai.needEndpoint'), tone: 'error' })
      return
    }
    setBusy(kind)
    setNote(null)
    try {
      if (!(await save())) return
      setNote(then ? await then() : { text: t('ai.saved'), tone: 'ok' })
    } catch (error) {
      setNote({ text: t('ai.failed', { reason: (error as Error).message }), tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const test = () =>
    act('test', async () => {
      const o = testOutcome(await testConnection())
      const why = typeof o.params.why === 'string' ? t(o.params.why as AiKey) : ''
      return { text: t(o.key, { ...o.params, why }), tone: o.ok ? 'ok' : 'error' }
    })
  const fetchList = () =>
    act('fetch', async () => {
      setModels(await fetchModels())
      return null
    })
  const probe = () =>
    act('probe', async () => {
      const max = Math.min(CONCURRENT?.max ?? 16, Math.max(PROBE_FROM, Number(form.concurrent) || 0))
      const r = await probeConcurrency(max)
      if (r.status !== 'ok' || r.recommended < 1) return { text: t('ai.adv.probeFailed'), tone: 'error' }
      draft.savedPart({ concurrent: String(r.recommended) })
      return { text: t('ai.adv.probed', { n: r.recommended }), tone: 'ok' }
    })

  return (
    <Section title={t('ai.vlm.title')} saved={justSaved === 'vlm'} testId="ai-vlm">
      <p className={styles.lead}>{t('ai.vlm.lead')}</p>
      <NowLine settings={settings} />
      <ConnectionFields draft={draft} settings={settings} busy={busy !== null} fetching={busy === 'fetch'} models={models} onFetch={() => void fetchList()} detected={detected} />
      <PromptFields draft={draft} />
      <AdvancedFields draft={draft} busy={busy !== null} probing={busy === 'probe'} onProbe={() => void probe()} invalid={invalid} />
      <ProxyFields draft={draft} />
      {form.provider === 'gemini' && <VertexFields draft={draft} settings={settings} />}
      <div className={styles.actions} data-testid="vlm-actions">
        <div className={styles.actionRow}>
          <button type="button" className="btn btn-primary" onClick={() => void act('save')} disabled={busy !== null} data-testid="vlm-save">
            {t(busy === 'save' ? 'ai.saving' : 'ai.save')}
          </button>
          <button type="button" className="btn" onClick={() => void test()} disabled={busy !== null} data-testid="vlm-test">
            {t(busy === 'test' ? 'ai.testing' : 'ai.test')}
          </button>
          {draft.dirty && <span className={styles.unsaved}>{t('ai.unsaved')}</span>}
          <p className={styles.barNote} data-tone={note?.tone} role="status" data-testid="vlm-note">
            {note?.text ?? ''}
          </p>
        </div>
      </div>
    </Section>
  )
}

/** What is stored and in force now (not what is being typed). */
function NowLine({ settings }: { settings: VlmSettings }) {
  const t = useAT()
  const r = vlmReadiness(settings)
  const model = settings.model?.trim() ?? ''
  const host = hostOf(settings.endpoint?.trim() ?? '')
  let text: string
  if (r.missing === 'endpoint') text = t('ai.vlm.none')
  else if (r.missing === 'key') text = t('ai.vlm.needKey')
  else if (settings.provider === 'gemini' && settings.use_vertex) text = t('ai.vlm.nowVertex', { model })
  else text = model ? t('ai.vlm.now', { model, host }) : t('ai.vlm.nowNoModel', { host })
  return (
    <p className={styles.now} data-tone={r.ready ? 'ready' : 'missing'} data-testid="vlm-now">
      {text}
    </p>
  )
}

/** Ask the backend which service a newly typed address is, and set the type (it can still be changed by hand). */
function useDetectedProvider(draft: VlmDraft): Provider | null {
  const [detected, setDetected] = useState<Provider | null>(null)
  const endpoint = draft.form.endpoint.trim()
  const changed = endpoint !== draft.baseline.endpoint.trim()
  const { set } = draft
  useEffect(() => {
    if (!changed || !/^https?:\/\/\S/i.test(endpoint)) return
    let live = true
    const timer = window.setTimeout(() => {
      detectProvider(endpoint)
        .then((provider) => {
          if (!live || !PROVIDERS.includes(provider as Provider)) return
          set((f) => withDetectedProvider(f, endpoint, provider))
          setDetected(provider as Provider)
        })
        .catch(() => {
          // best effort: the service type stays as it is and can be picked by hand
        })
    }, DETECT_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [endpoint, changed, set])
  return detected !== null && draft.form.provider === detected ? detected : null
}
