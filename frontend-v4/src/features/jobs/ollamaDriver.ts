import { api, unwrap } from '../../api/client'
import { at } from '../settings/ai/aiText'
import { readProgress } from './progress'

// Polls an Ollama model download for the Jobs drawer (read by ollamaJob.ts).
// The backend cannot stop a pull, so the drawer offers no Stop.

type Raw = Record<string, unknown>

export const driveOllama = {
  poll: async (): Promise<unknown> => unwrap(await api.GET('/api/vlm/local-models/pull/progress')),
  cancel: null,
}

/** A pull already running when V4 opened (a reload, or V3.5 started it). */
export function ollamaAdoption(raw: Raw) {
  const model = typeof raw.model === 'string' ? raw.model : ''
  if (raw.pulling !== true || !model) return null
  const ctx = { ollamaModel: model }
  return { kind: 'ollama' as const, ctx, label: at('ai.ollama.job', { model }), progress: readProgress('ollama', raw, ctx) }
}
