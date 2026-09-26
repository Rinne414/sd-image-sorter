import { fetchModelStatus } from '../../api/queries'
import { queryClient } from '../../api/queryClient'
import { useToasts } from '../../ui/toasts'
import { installThen } from '../jobs/installJob'
import { tr } from '../jobs/jobs'
import type { ModelCard } from '../tagging/taggers'

// Searching by meaning, by an image file, or building the index needs CLIP
// (about 580 MB). The first time, it downloads as a job in the Jobs drawer
// and the search runs when it is done — the same first-use flow as taggers.

export const CLIP = { card: 'clip', variant: null, label: 'CLIP' } as const

export type ClipState = 'ready' | 'download' | 'restart'

export function clipState(cards: readonly ModelCard[] | undefined): ClipState {
  const card = cards?.find((c) => c.id === CLIP.card)
  // Unknown: let the work try; the backend says what is missing.
  if (!card) return 'ready'
  if (card.status === 'needs_restart') return 'restart'
  return card.status === 'ready' || card.available === true ? 'ready' : 'download'
}

/** Run `work` now if CLIP is on disk, else download it first. False when neither can happen. */
export async function withClip(work: () => void): Promise<boolean> {
  let cards: ModelCard[] | undefined
  try {
    cards = (await queryClient.fetchQuery({ queryKey: ['model-status'], queryFn: () => fetchModelStatus(), staleTime: 0 })).models
  } catch {
    cards = undefined
  }
  const state = clipState(cards)
  if (state === 'restart') {
    useToasts.getState().push(tr('tagging.needsRestart', { name: CLIP.label }), 'error')
    return false
  }
  if (state === 'ready') {
    work()
    return true
  }
  return installThen(CLIP, work)
}
