import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from '../../../api/client'
import { queryClient } from '../../../api/queryClient'
import type { Batch } from '../../../api/types'
import { useApp } from '../../../state/store'
import { useToasts } from '../../../ui/toasts'
import type { DatasetForm, TargetModel } from '../datasetSettings'
import type { ExactCount, ExactTokens } from './captionChecks'
import type { Finals } from './checkApi'

// Exact caption token counts with the tokenizers the base model reads captions
// with: SDXL (and no base model) CLIP ViT-L/14, FLUX T5 v1.1 XXL, Krea 2 Qwen3,
// Anima Qwen3-0.6B and T5 v1.1 XXL (backend caption_tokenizer_service says why
// each is exact). A model's files (2 to 14 MB) are fetched once, on request;
// until they are there the check keeps its labelled estimate.

export type TokenProfile = 'sdxl' | 'flux' | 'krea2' | 'anima'

/** The tokenizer profile of a base model; no choice counts as CLIP, as the estimate does. */
export const tokenProfile = (model: TargetModel): TokenProfile => (model === '' ? 'sdxl' : model)

export interface TokenizerStatus {
  profile: TokenProfile
  /** The base model's name ("SDXL", "Krea 2", ...). */
  model: string
  /** Tokens of a caption the model keeps. */
  limit: number
  available: boolean
  tokenizers_package: boolean
  files: { id: string; label: string; size_bytes: number; present: boolean }[]
  /** Bytes still to download. */
  download_bytes: number
  preparing: boolean
  step: string
  error: string | null
}

const statusKey = (profile: TokenProfile) => ['caption-tokenizers', profile]
const POLL_MS = 1000

export function useTokenizerStatus(profile: TokenProfile, enabled: boolean) {
  return useQuery({
    queryKey: statusKey(profile),
    enabled,
    queryFn: async ({ signal }) =>
      unwrap<TokenizerStatus>(await api.GET('/api/dataset/caption-tokens/status', { params: { query: { profile } }, signal })),
    // Looked at again while the download runs; otherwise it only changes when the user asks.
    refetchInterval: (query) => (query.state.data?.preparing ? POLL_MS : false),
    staleTime: 30_000,
  })
}

/** Starts the one-time download (and the package install when it is missing); the status query follows it. */
export async function prepareTokenizers(profile: TokenProfile): Promise<void> {
  try {
    unwrap(await api.POST('/api/dataset/caption-tokens/prepare', { params: { query: { profile } } }))
  } catch (error) {
    useToasts.getState().push((error as Error).message, 'error')
  }
  await queryClient.invalidateQueries({ queryKey: statusKey(profile) })
}

/** Captions asked for per request. */
const CHUNK = 400

/** Short names for the per-picture note ("CLIP 80", "Qwen3 300 · T5 310"). */
const SHORT_LABELS: Record<string, string> = { clip_vit_l_14: 'CLIP', qwen3_0_6b: 'Qwen3', t5_v1_1_xxl: 'T5' }

/** A short fingerprint of the captions, so a changed caption counts again without keeping the text in a query key. */
function fingerprint(texts: readonly string[]): string {
  let hash = 2166136261
  for (const text of texts) {
    for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
    hash = Math.imul(hash ^ 10, 16777619)
  }
  return `${texts.length}:${(hash >>> 0).toString(16)}`
}

interface CountAnswer {
  available: boolean
  metrics: { id: string; label: string }[]
  counts: Record<string, number>[]
}

/** Exact counts of every final caption with the base model's tokenizers, by entry key; null while not asked for or not available. */
export function useExactTokens(batch: Batch, form: DatasetForm | null, finals: Finals | undefined, ready: boolean) {
  const library = useApp((s) => s.libraryId)
  const keys = finals ? [...finals.captions.keys()] : []
  const texts = finals ? [...finals.captions.values()] : []
  const profile = form ? tokenProfile(form.targetModel) : null
  return useQuery({
    queryKey: ['check-tokens', library, batch.id, profile, fingerprint(texts)],
    enabled: profile !== null && ready && keys.length > 0,
    queryFn: async ({ signal }): Promise<ExactTokens | null> => {
      const out = new Map<string, ExactCount>()
      for (let i = 0; i < texts.length; i += CHUNK) {
        const answer = unwrap<CountAnswer>(
          await api.POST('/api/dataset/caption-tokens', { body: { profile: profile as TokenProfile, texts: texts.slice(i, i + CHUNK) }, signal }),
        )
        if (!answer.available) return null
        answer.counts.forEach((row, n) => {
          const counts = answer.metrics.map((m) => ({ label: SHORT_LABELS[m.id] ?? m.label, tokens: Number(row[m.id]) }))
          out.set(keys[i + n] as string, { counts, tokens: Math.max(...counts.map((c) => c.tokens)) })
        })
      }
      return out
    },
    staleTime: Infinity,
  })
}
