import { at, type AiKey } from '../settings/ai/aiText'
import type { JobProgress } from './progress'

// Reads an Ollama model download for the Jobs drawer: GET
// /api/vlm/local-models/pull/progress answers { pulling, model, percent,
// status }. Only a percentage is known (no sizes); the backend runs one pull
// at a time and cannot stop it. ollamaDriver.ts polls.

type Raw = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** Ollama's own step names, in words. */
function step(status: string): string | null {
  const s = status.toLowerCase()
  let key: AiKey | null = null
  if (s === 'starting') key = 'ai.ollama.phase.starting'
  else if (s === 'pulling manifest') key = 'ai.ollama.phase.manifest'
  else if (s.startsWith('pulling')) key = 'ai.ollama.phase.files'
  else if (s.startsWith('verifying')) key = 'ai.ollama.phase.verify'
  else if (s.startsWith('writing') || s.startsWith('removing')) key = 'ai.ollama.phase.write'
  return key ? at(key) : status || null
}

/** `model`: the one we asked for; another model on the backend means ours is gone. */
export function readOllama(base: JobProgress, raw: Raw, model?: string): JobProgress {
  const pulling = raw.pulling === true
  const status = str(raw.status)
  const percent = Math.max(0, Math.min(100, Math.round(num(raw.percent))))
  const shown = { ...base, unit: 'percent' as const, total: 100, current: percent }
  if (model !== undefined && str(raw.model) !== model) return { ...shown, status: 'idle', currentItem: null, message: '' }
  if (pulling) return { ...shown, status: 'running', currentItem: step(status), message: '' }
  if (status.startsWith('error')) return { ...shown, status: 'error', currentItem: null, message: status.replace(/^error:?\s*/, '') || status }
  return { ...shown, status: 'done', current: 100, succeeded: 1, currentItem: null, message: '' }
}

