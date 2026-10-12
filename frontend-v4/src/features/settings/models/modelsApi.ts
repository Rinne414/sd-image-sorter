import { useQuery } from '@tanstack/react-query'
import { api, ApiError, unwrap } from '../../../api/client'
import { queryClient } from '../../../api/queryClient'
import { copyText } from '../../../lib/format'
import { useToasts } from '../../../ui/toasts'
import { folderOf } from './modelCards'
import { mt } from './modelText'
import type { BulkBundle, MirrorState, ModelPlan, ModelStatusResponse } from './types'

// What the Model Center reads and writes. The status shares its cache key with
// the tag panel and the first-use downloads, so a finished download (the job
// refreshes 'model-status') updates every card.

const toast = (text: string, tone: 'info' | 'error' = 'info') => useToasts.getState().push(text, tone)

export function useModelCards() {
  return useQuery({
    queryKey: ['model-status'],
    queryFn: async ({ signal }) => unwrap<ModelStatusResponse>(await api.GET('/api/models/status', { signal })),
    staleTime: 5_000,
  })
}

const MIRROR_KEY = ['model-mirror'] as const

export function useMirror() {
  return useQuery({
    queryKey: MIRROR_KEY,
    queryFn: async ({ signal }) => unwrap<MirrorState>(await api.GET('/api/models/mirror', { signal })),
    staleTime: Infinity,
  })
}

/** Save the download source; true when it was saved (a failure is said). */
export async function saveMirror(mirror: string): Promise<boolean> {
  try {
    const saved = unwrap<MirrorState>(await api.POST('/api/models/mirror', { body: { mirror } }))
    queryClient.setQueryData<MirrorState>(MIRROR_KEY, (old) => ({ ...old, mirror: saved.mirror }))
    return true
  } catch (error) {
    toast(mt('mc.mirror.saveFailed', { reason: (error as Error).message }), 'error')
    return false
  }
}

/** What preparing a missing card would install and whether it restarts (read-only on the backend). */
export function useModelPlan(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['model-plan', id],
    queryFn: async ({ signal }) => unwrap<ModelPlan>(await api.GET('/api/models/plan', { params: { query: { model_id: id } }, signal })),
    enabled,
    staleTime: 60_000,
  })
}

export function useBulkBundle() {
  return useQuery({
    queryKey: ['model-bulk'],
    queryFn: async ({ signal }) => unwrap<BulkBundle>(await api.GET('/api/models/bulk-bundle', { signal })),
    staleTime: 0,
  })
}

export async function copyModelPath(path: string): Promise<void> {
  const ok = await copyText(path)
  toast(mt(ok ? 'mc.manual.copied' : 'mc.manual.copyFailed'), ok ? 'info' : 'error')
}

/** Open the folder a model goes in; a folder that does not exist yet is explained, not an error code. */
export async function openModelFolder(path: string): Promise<void> {
  try {
    unwrap(await api.POST('/api/open-path', { body: { path: folderOf(path) } }))
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) toast(mt('mc.manual.noFolder'), 'error')
    else toast(mt('mc.manual.openFailed', { reason: (error as Error).message }), 'error')
  }
}
