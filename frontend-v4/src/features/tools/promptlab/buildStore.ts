import { create } from 'zustand'
import { api, unwrap } from '../../../api/client'
import { queryClient } from '../../../api/queryClient'
import type { ImageDetailResponse } from '../../../api/types'
import { useToasts } from '../../../ui/toasts'
import { tr } from '../../jobs/jobs'
import { cleanTags, mergeInto } from './buildCleanup'
import { setMode } from './labStore'
import { plt } from './plText'

// Build's prompt: started from one image or from a draft (Compare's words, a
// stats tag, a recipe), edited freely, kept across restarts.

export type DraftFrom = 'compare' | 'stats' | 'recipe' | 'random'

export type BuildOrigin = { kind: 'image'; id: number } | { kind: 'draft'; from: DraftFrom; name?: string } | null

interface Build {
  origin: BuildOrigin
  prompt: string
  negative: string
  /** Reading the source image's prompt. */
  loading: boolean
  error: string | null
}

const KEY = 'sd-v4-promptlab-build'

function load(): Build {
  const empty: Build = { origin: null, prompt: '', negative: '', loading: false, error: null }
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Build> | null
    if (!raw || typeof raw !== 'object') return empty
    return {
      ...empty,
      origin: raw.origin ?? null,
      prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
      negative: typeof raw.negative === 'string' ? raw.negative : '',
    }
  } catch {
    return empty
  }
}

export const useBuild = create<Build>(load)

useBuild.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ origin: s.origin, prompt: s.prompt, negative: s.negative }))
  } catch {
    // storage blocked: kept for this visit only
  }
})

/** One image's details, from the same cache the library's card reads. */
export function fetchImageDetail(id: number): Promise<ImageDetailResponse> {
  return queryClient.fetchQuery({
    queryKey: ['image', id],
    queryFn: async ({ signal }) => unwrap<ImageDetailResponse>(await api.GET('/api/images/{image_id}', { params: { path: { image_id: id } }, signal })),
    staleTime: 60_000,
  })
}

type Snapshot = Pick<Build, 'origin' | 'prompt' | 'negative'>

const snapshot = (): Snapshot => {
  const { origin, prompt, negative } = useBuild.getState()
  return { origin, prompt, negative }
}

/** A toast whose Undo puts the build back the way it was. */
function withUndo(text: string, before: Snapshot): void {
  useToasts.getState().push(text, 'info', { label: tr('toast.undo'), run: () => useBuild.setState(before) })
}

/** Build from this image: its prompt and negative replace the text. */
export async function openBuildImage(id: number): Promise<void> {
  setMode('build')
  useBuild.setState({ origin: { kind: 'image', id }, loading: true, error: null })
  try {
    const { image } = await fetchImageDetail(id)
    const origin = useBuild.getState().origin
    if (origin?.kind !== 'image' || origin.id !== id) return
    useBuild.setState({ prompt: image.prompt ?? '', negative: image.negative_prompt ?? '', loading: false })
  } catch (error) {
    const origin = useBuild.getState().origin
    if (origin?.kind === 'image' && origin.id === id) useBuild.setState({ loading: false, error: (error as Error).message })
  }
}

/** A draft from other words: they become the prompt (the old text can be had back). */
export function startDraft(words: readonly string[], from: DraftFrom, name?: string): void {
  const before = snapshot()
  setMode('build')
  useBuild.setState({ origin: name ? { kind: 'draft', from, name } : { kind: 'draft', from }, prompt: cleanTags(words).join(', '), negative: '', loading: false, error: null })
  withUndo(plt('pl.sentToBuild'), before)
}

/** Add words to the prompt (each once), staying where the user is. */
export function addToBuild(words: readonly string[]): void {
  const before = snapshot()
  const { text, added } = mergeInto(before.prompt, words)
  if (added === 0) {
    useToasts.getState().push(plt('pl.alreadyInBuild'))
    return
  }
  useBuild.setState({ prompt: text, origin: before.origin ?? { kind: 'draft', from: 'stats' } })
  withUndo(plt('pl.addedToBuild', { tags: words.join(', ') }), before)
}

export function setPrompt(prompt: string): void {
  useBuild.setState({ prompt })
}

export function setNegative(negative: string): void {
  useBuild.setState({ negative })
}

/** Replace the prompt (a clean-up, the ticked groups) with an undo. */
export function replacePrompt(prompt: string, message: string): void {
  const before = snapshot()
  useBuild.setState({ prompt })
  withUndo(message, before)
}

export function clearBuild(): void {
  const before = snapshot()
  useBuild.setState({ origin: null, prompt: '', negative: '', loading: false, error: null })
  withUndo(plt('pl.build.cleared'), before)
}
