import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from '../../../api/client'
import { queryClient } from '../../../api/queryClient'
import type { Batch } from '../../../api/types'
import { useApp } from '../../../state/store'
import { useToasts } from '../../../ui/toasts'
import type { DatasetForm } from '../datasetSettings'
import type { ExactTokens } from './captionChecks'
import type { Finals } from './checkApi'

// Exact caption token counts for Anima (Qwen3-0.6B and T5 v1.1 XXL). The two
// tokenizer files (about 14 MB) are fetched once, on request; until they are
// there the check keeps its labelled estimate.

export interface TokenizerStatus {
  available: boolean
  tokenizers_package: boolean
  files: { id: string; label: string; size_bytes: number; present: boolean }[]
  /** Bytes still to download. */
  download_bytes: number
  preparing: boolean
  step: string
  error: string | null
}

const STATUS_KEY = ['caption-tokenizers']
const POLL_MS = 1000

export function useTokenizerStatus(enabled: boolean) {
  return useQuery({
    queryKey: STATUS_KEY,
    enabled,
    queryFn: async ({ signal }) => unwrap<TokenizerStatus>(await api.GET('/api/dataset/caption-tokens/status', { signal })),
    // Looked at again while the download runs; otherwise it only changes when the user asks.
    refetchInterval: (query) => (query.state.data?.preparing ? POLL_MS : false),
    staleTime: 30_000,
  })
}

/** Starts the one-time download (and the package install when it is missing); the status query follows it. */
export async function prepareTokenizers(): Promise<void> {
  try {
    unwrap(await api.POST('/api/dataset/caption-tokens/prepare'))
  } catch (error) {
    useToasts.getState().push((error as Error).message, 'error')
  }
  await queryClient.invalidateQueries({ queryKey: STATUS_KEY })
}

/** Captions asked for per request. */
const CHUNK = 400

/** A short fingerprint of the captions, so a changed caption counts again without keeping the text in a query key. */
function fingerprint(texts: readonly string[]): string {
  let hash = 2166136261
  for (const text of texts) {
    for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
    hash = Math.imul(hash ^ 10, 16777619)
  }
  return `${texts.length}:${(hash >>> 0).toString(16)}`
}

/** Exact counts of every final caption, by entry key; null while not asked for or not available. */
export function useExactTokens(batch: Batch, form: DatasetForm | null, finals: Finals | undefined, ready: boolean) {
  const library = useApp((s) => s.libraryId)
  const keys = finals ? [...finals.captions.keys()] : []
  const texts = finals ? [...finals.captions.values()] : []
  return useQuery({
    queryKey: ['check-tokens', library, batch.id, fingerprint(texts)],
    enabled: form?.targetModel === 'anima' && ready && keys.length > 0,
    queryFn: async ({ signal }): Promise<ExactTokens | null> => {
      const out = new Map<string, { qwen: number; t5: number }>()
      for (let i = 0; i < texts.length; i += CHUNK) {
        const answer = unwrap<{ available: boolean; counts: { qwen3_0_6b: number; t5_v1_1_xxl: number }[] }>(
          await api.POST('/api/dataset/caption-tokens', { body: { profile: 'anima', texts: texts.slice(i, i + CHUNK) }, signal }),
        )
        if (!answer.available) return null
        answer.counts.forEach((c, n) => out.set(keys[i + n] as string, { qwen: c.qwen3_0_6b, t5: c.t5_v1_1_xxl }))
      }
      return out
    },
    staleTime: Infinity,
  })
}
