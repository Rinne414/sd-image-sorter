import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from '../../../api/client'
import type { TagCategory } from '../../../api/types'
import type { ModelCard } from '../../tagging/taggers'

// Help while editing tags: TIPO's suggestions for tags the tagger has no
// label for, what the app knows about one tag, and a Chinese reading aid.
// None of them writes anything: the user picks what goes into the caption.

// ---- TIPO -------------------------------------------------------------------

export type TipoModel = 'v2.1' | '200m-ft'

export const TIPO_MODELS: readonly { id: TipoModel; size: string }[] = [
  { id: 'v2.1', size: '1.1 GB' },
  { id: '200m-ft', size: '210 MB' },
]

// Shared with V3.5's separation console, so the choice carries between them.
const TIPO_KEY = 'sd-tipo-model-v1'

export function loadTipoModel(): TipoModel {
  try {
    const saved = localStorage.getItem(TIPO_KEY)
    if (saved === 'v2.1' || saved === '200m-ft') return saved
  } catch {
    // storage blocked
  }
  return 'v2.1'
}

export function saveTipoModel(model: TipoModel): void {
  try {
    localStorage.setItem(TIPO_KEY, model)
  } catch {
    // storage blocked: the choice lasts this session
  }
}

/** The weights are on disk; a first run downloads them otherwise. */
export function tipoInstalled(cards: readonly ModelCard[] | undefined, model: TipoModel): boolean {
  const card = cards?.find((c) => c.id === 'tipo')
  return !!card?.installed_variants?.includes(model)
}

export interface TipoProposal {
  tag: string
  category: TagCategory
}

/** TIPO's proposals for this caption's tags (nothing is applied). */
export async function suggestUpsample(tags: readonly string[], model: TipoModel, imageId: number | null): Promise<TipoProposal[]> {
  const res = unwrap<{ proposed_tags: TipoProposal[] }>(
    await api.POST('/api/tags/suggest-upsample', {
      body: { tags: tags.slice(0, 200), target: 'short', model, ...(imageId !== null ? { image_id: imageId } : {}) },
    }),
  )
  return res.proposed_tags
}

// ---- tag info ---------------------------------------------------------------

export interface TagInfo {
  tag: string
  canonical: string
  found_in_vocab: boolean
  category: TagCategory | null
  danbooru_count: number
  aliases: string[]
  zh: string | null
  copyright: string | null
  parent_tag: string | null
  implies: string[]
  implied_by: string[]
  library_count: number
}

export function useTagInfo(tag: string | null) {
  return useQuery({
    queryKey: ['tag-info', tag],
    enabled: !!tag,
    queryFn: async ({ signal }) => unwrap<TagInfo>(await api.GET('/api/tags/info', { params: { query: { tag: tag as string } }, signal })),
    staleTime: 5 * 60_000,
  })
}

// ---- Chinese reading aid ----------------------------------------------------

/** Who translates: a free web service (China-friendly chain first), or the vision model set up in Settings › AI services. */
export type ZhSource = 'off' | 'web' | 'vlm'

const ZH_KEY = 'sd-v4-caption-zh'

export function loadZhSource(): ZhSource {
  try {
    const saved = localStorage.getItem(ZH_KEY)
    if (saved === 'web' || saved === 'vlm') return saved
  } catch {
    // storage blocked
  }
  return 'off'
}

export function saveZhSource(source: ZhSource): void {
  try {
    localStorage.setItem(ZH_KEY, source)
  } catch {
    // storage blocked: the choice lasts this session
  }
}

/** The body of POST /api/dataset/translate for these tags. */
export function translateBody(tags: readonly string[], source: Exclude<ZhSource, 'off'>) {
  return {
    texts: tags.slice(0, 200),
    mode: 'tags',
    target_lang: 'zh-CN',
    provider_mode: source === 'vlm' ? 'vlm' : 'external',
    external_provider: source === 'vlm' ? '' : 'auto_cn',
  }
}

/** Translations already fetched, per source (lowercase tag -> Chinese; '' = the service had none). */
const zhKnown: Record<Exclude<ZhSource, 'off'>, Map<string, string>> = { web: new Map(), vlm: new Map() }

/**
 * Chinese for each tag (lowercase key). Only tags not translated before are
 * sent, so adding one tag asks for one tag; tags the service left blank are
 * missing from the map.
 */
export function useTagZh(tags: readonly string[], source: ZhSource) {
  const known = source === 'off' ? null : zhKnown[source]
  const missing = known ? [...new Set(tags.map((t) => t.trim()).filter((t) => t && !known.has(t.toLowerCase())))].sort() : []
  const query = useQuery({
    queryKey: ['tag-zh', source, missing.join('|')],
    enabled: known !== null && missing.length > 0,
    queryFn: async ({ signal }) => {
      const res = unwrap<{ translations: string[] }>(
        await api.POST('/api/dataset/translate', { body: translateBody(missing, source as Exclude<ZhSource, 'off'>) as never, signal }),
      )
      missing.forEach((tag, i) => known?.set(tag.toLowerCase(), (res.translations[i] ?? '').trim()))
      return missing.length
    },
    staleTime: Infinity,
    retry: false,
  })
  const map = new Map<string, string>()
  if (known) {
    for (const tag of tags) {
      const zh = known.get(tag.toLowerCase())
      if (zh && zh.toLowerCase() !== tag.toLowerCase()) map.set(tag.toLowerCase(), zh)
    }
  }
  return { data: known ? map : undefined, isError: query.isError, isFetching: query.isFetching }
}
