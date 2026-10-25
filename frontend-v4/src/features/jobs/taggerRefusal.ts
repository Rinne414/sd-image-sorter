import type { MessageKey } from '../../i18n'

// The tagger's refusal to start, or go on, on the CPU without enough free
// memory (PixAI v1.0 needs about 6 GB). The backend sends the code
// tagger_cpu_memory_short, plus the cause, with model / need_gb / free_gb:
// as message_key cpu_memory_short in tag and Smart Tag progress, and as the
// error body of POST /api/tag/single. Pure: the caller translates.

const REFUSAL_KEYS: Record<string, MessageKey> = {
  tagger_cpu_memory_short: 'tagger.cpuShort',
  tagger_cpu_memory_short_gpu_busy: 'tagger.cpuShort.gpuBusy',
  tagger_cpu_memory_short_gpu_start_failed: 'tagger.cpuShort.gpuStartFailed',
  tagger_cpu_memory_short_gpu_stopped: 'tagger.cpuShort.gpuStopped',
}

export interface TaggerRefusal {
  key: MessageKey
  params: { model: string; need_gb: string; free_gb: string }
}

/** The refusal for a backend error code and its params; null for any other code. */
export function taggerRefusal(code: unknown, params: unknown): TaggerRefusal | null {
  const key = typeof code === 'string' ? REFUSAL_KEYS[code] : undefined
  if (!key) return null
  const p = params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
  const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
  return { key, params: { model: text(p.model), need_gb: text(p.need_gb), free_gb: text(p.free_gb) } }
}

/** The refusal a tag or Smart Tag progress answer carries, if it is one. */
export function refusalOfProgress(raw: Record<string, unknown>): TaggerRefusal | null {
  if (raw.message_key !== 'cpu_memory_short') return null
  const args = raw.message_args && typeof raw.message_args === 'object' ? (raw.message_args as Record<string, unknown>) : {}
  return taggerRefusal(args.code, args)
}
