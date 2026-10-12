import { api, unwrap } from '../../api/client'
import type { paths } from '../../api/schema'
import type { ImageSummary, ImagesPage } from '../../api/types'
import type { ImageQueryParams } from '../../lib/searchQuery'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'
import { currentLibraryParams } from './params'
import { imageAtQuery, randomOffset } from './random'

type ImagesQuery = NonNullable<paths['/api/images']['get']['parameters']['query']>

/** The one image at `offset` in the result for `params`, and the result's size. */
export async function fetchImageAt(params: ImageQueryParams, offset: number): Promise<{ image: ImageSummary | null; total: number }> {
  const query = imageAtQuery(params, offset) as ImagesQuery
  const page = unwrap<ImagesPage>(await api.GET('/api/images', { params: { query } }))
  return { image: page.images[0] ?? null, total: page.total }
}

/** Ctrl K "random image": any image of the current filter, opened big, loaded page or not. */
export async function openRandom(): Promise<void> {
  const s = useApp.getState()
  if (s.page !== 'library') s.setPage('library')
  const params = currentLibraryParams()
  try {
    // The first request learns the size of the result; a one-image result needs no second.
    const first = await fetchImageAt(params, 0)
    const at = randomOffset(first.total)
    const hit = at <= 0 ? first.image : (await fetchImageAt(params, at)).image
    if (!hit) {
      useToasts.getState().push(tr('lib.random.empty'), 'info')
      return
    }
    useApp.getState().openLightboxAt(hit.id, Math.max(at, 0))
  } catch (error) {
    useToasts.getState().push(tr('lib.random.failed', { reason: (error as Error).message }), 'error')
  }
}
