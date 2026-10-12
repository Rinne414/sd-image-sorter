import { api, unwrap } from '../../api/client'
import { queryClient } from '../../api/queryClient'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { jobHeadline, tr, useJobs, type Job } from '../jobs/jobs'
import { isTagger } from '../tagging/taggers'
import { loadTagOptions, startTagging, TAG_ONLY } from '../tagging/tagJob'

// What follows a finished import: say what came in and offer to look at just
// that; move images another library holds into this one; and, when the user
// asked for it, tag every untagged image with their last tagging settings.

/** Show only the imported folder, newest first, in the library. */
export function showImported(folder: string): void {
  const s = useApp.getState()
  s.setPage('library')
  s.setQueryText('')
  s.setScope({ favorites: false, generators: [], folder })
  s.setSort('newest')
}

/** Paths claimed per request, as V3.5 does. */
const CLAIM_BATCH = 2000

/** Move images another library holds into the current one (files stay where they are). */
export async function claimIntoLibrary(paths: string[]): Promise<boolean> {
  try {
    let moved = 0
    for (let i = 0; i < paths.length; i += CLAIM_BATCH) {
      const res = unwrap<{ moved?: number }>(await api.POST('/api/libraries/claim-paths', { body: { paths: paths.slice(i, i + CLAIM_BATCH) } }))
      moved += res.moved ?? 0
    }
    for (const key of ['images', 'image-count', 'libraries', 'generators', 'folders', 'library-health']) void queryClient.invalidateQueries({ queryKey: [key] })
    useToasts.getState().push(tr('import.next.claimed', { n: moved }), 'info')
    return true
  } catch (error) {
    useToasts.getState().push(tr('error.generic', { reason: (error as Error).message }), 'error')
    return false
  }
}

/** Tag every untagged image with the last tagging settings (a tagger no longer offered falls back to the default). */
async function tagUntagged(count: number): Promise<void> {
  try {
    const models = unwrap<{ models: { name: string; disabled?: boolean }[]; default: string }>(await api.GET('/api/tagger/models'))
    const last = loadTagOptions(models.default)
    const known = models.models.some((m) => m.name === last.model && isTagger(m.name) && !m.disabled)
    const options = known ? last : { ...last, model: models.default, threshold: null, characterThreshold: null }
    await startTagging(null, options, count, TAG_ONLY)
  } catch (error) {
    useToasts.getState().push(tr('error.generic', { reason: (error as Error).message }), 'error')
  }
}

/**
 * Runs when an import of ours ends well (the drawer keeps the same offers).
 * `untaggedBefore` is what the library had untagged when it started.
 */
export async function afterImport(job: Job, tagAfter: boolean, untaggedBefore: number): Promise<void> {
  const p = job.progress
  const troubled = p.failedCount > 0
  const folder = job.destination
  const action = troubled
    ? { label: tr('jobs.show'), run: () => useJobs.getState().setDrawerOpen(true) }
    : folder && p.succeeded > 0
      ? { label: tr('import.next.show'), run: () => showImported(folder) }
      : undefined
  const text = jobHeadline(job) + (tagAfter ? tr('import.thenTagging') : '')
  useToasts.getState().push(text, troubled ? 'error' : 'info', action)
  const other = p.scan?.otherLibrary
  if (other && other.count > 0 && other.paths.length > 0) {
    useToasts.getState().push(tr('import.next.otherLibrary', { n: other.count }), 'info', {
      label: tr('import.next.claim', { n: other.paths.length }),
      run: () => void claimIntoLibrary(other.paths),
    })
  }
  if (tagAfter) await tagUntagged(untaggedBefore + p.succeeded)
}
