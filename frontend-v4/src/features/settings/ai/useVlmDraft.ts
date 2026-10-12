import { useCallback, useState } from 'react'
import type { VlmSettings } from './types'
import { formFromSettings, isDirty, type VlmForm } from './vlmForm'

export interface VlmDraft {
  form: VlmForm
  set: (patch: Partial<VlmForm> | ((f: VlmForm) => VlmForm)) => void
  /** What is stored now (secrets are never kept here). */
  baseline: VlmForm
  dirty: boolean
  /** `sent` was saved: typed secrets are forgotten (the field shows the mask again). */
  saved: (sent: VlmForm) => void
  /** Some fields were saved on their own (Use a local model, the probed limit): both sides take them. */
  savedPart: (patch: Partial<VlmForm>) => void
}

/** The VLM form being edited on Settings › AI services, and what was last saved. */
export function useVlmDraft(settings: VlmSettings): VlmDraft {
  const [form, setForm] = useState(() => formFromSettings(settings))
  const [baseline, setBaseline] = useState(() => formFromSettings(settings))
  // stable, so effects that change the form (the recognised service type) run once per address
  const set = useCallback<VlmDraft['set']>((patch) => setForm((f) => (typeof patch === 'function' ? patch(f) : { ...f, ...patch })), [])
  return {
    form,
    set,
    baseline,
    dirty: isDirty(form, baseline),
    saved: (sent) => {
      setBaseline({ ...sent, apiKey: '', serviceAccountJson: '' })
      // anything typed while the save was on its way stays
      setForm((f) => ({
        ...f,
        apiKey: f.apiKey === sent.apiKey ? '' : f.apiKey,
        serviceAccountJson: f.serviceAccountJson === sent.serviceAccountJson ? '' : f.serviceAccountJson,
      }))
    },
    savedPart: (patch) => {
      setForm((f) => ({ ...f, ...patch }))
      setBaseline((b) => ({ ...b, ...patch }))
    },
  }
}
