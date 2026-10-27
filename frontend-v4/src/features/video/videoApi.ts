import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from '../../api/client'
import { queryClient } from '../../api/queryClient'
import { rawJson } from '../../api/raw'
import { translate, useLang, type MessageKey, type Params } from '../../i18n'
import { useApp } from '../../state/store'
import { useToasts } from '../../ui/toasts'
import { addJob, isQueueBusy } from '../jobs/jobs'
import { startedVideoInstall } from '../jobs/videoJob'

// What video support reads and does: the ffmpeg status and install, how many
// videos the library holds, and a video's playback facts. These routes are not
// in the generated schema, so they go through rawJson.

export interface VideoInstall {
  state: 'idle' | 'running' | 'done' | 'failed'
  phase?: 'looking' | 'downloading' | 'unpacking' | 'done'
  downloaded?: number
  total?: number | null
  error?: string
}

export interface VideoSupport {
  available: boolean
  source: 'installed' | 'beside_program' | 'path' | null
  can_install: boolean
  estimated_mb: number | null
  download_from: string
  install: VideoInstall
  indexing: boolean
  /** Videos indexed, and how many still wait to be read. */
  videos: number
  pending: number
  unreadable: number
}

export interface ConvertedPreview {
  status: 'none' | 'queued' | 'running' | 'done' | 'failed'
  progress: number
  error: string | null
}

export interface Playback {
  id: number
  codec: string | null
  duration: number | null
  fps: number | null
  has_audio: boolean
  probe_state: string | null
  probe_error: string | null
  plays_in_browser: boolean
  tools_available: boolean
  converted: ConvertedPreview
  converted_url: string
}

const say = (key: MessageKey, params?: Params) => translate(useLang.getState().lang, key, params)

export const VIDEO_SUPPORT_KEY = ['video-support'] as const
const BUSY_POLL_MS = 2000
const IDLE_POLL_MS = 60_000

let lastPending: number | null = null

/** Videos that finished being read: the library shows their frames and lengths now. */
function noticeFinishedVideos(state: VideoSupport): void {
  if (lastPending !== null && state.pending < lastPending) {
    for (const key of ['images', 'image', 'image-count']) void queryClient.invalidateQueries({ queryKey: [key] })
  }
  lastPending = state.pending
}

const isBusy = (s: VideoSupport | undefined) => s?.install.state === 'running' || (s?.available === true && s.pending > 0)

/** The ffmpeg status; polled quickly while it installs or videos are being read. */
export function useVideoSupport() {
  return useQuery({
    queryKey: VIDEO_SUPPORT_KEY,
    queryFn: async ({ signal }) => {
      const state = await rawJson<VideoSupport>('GET', '/api/video-support', { signal })
      noticeFinishedVideos(state)
      return state
    },
    refetchInterval: (query) => (isBusy(query.state.data) ? BUSY_POLL_MS : IDLE_POLL_MS),
    staleTime: 5_000,
  })
}

/** How many videos this library holds (the media toggle shows only when there are some). */
export function useLibraryVideoCount(): number {
  const libraryId = useApp((s) => s.libraryId)
  const q = useQuery({
    // Starts with image-count, so a scan or a removal refreshes it.
    queryKey: ['image-count', 'video', libraryId],
    queryFn: async ({ signal }) => unwrap<{ video_count?: number }>(await api.GET('/api/stats', { signal })).video_count ?? 0,
    staleTime: 30_000,
  })
  return q.data ?? 0
}

/** Ask the backend to install ffmpeg; it runs in the background and shows in the Jobs drawer. */
export async function installVideoSupport(): Promise<void> {
  if (isQueueBusy('video')) return
  try {
    const install = await rawJson<VideoInstall>('POST', '/api/video-support/install', { body: {} })
    addJob({ kind: 'video', progress: startedVideoInstall(install as unknown as Record<string, unknown>), label: say('video.job.label') })
  } catch (error) {
    useToasts.getState().push(say('video.installFailed', { reason: (error as Error).message }), 'error')
  }
  void queryClient.invalidateQueries({ queryKey: VIDEO_SUPPORT_KEY })
}

export const getPlayback = (id: number, signal?: AbortSignal) => rawJson<Playback>('GET', `/api/videos/${id}/playback`, { signal })

export const requestConvertedPreview = (id: number) => rawJson<ConvertedPreview>('POST', `/api/videos/${id}/converted`, { body: {} })

export const videoFileUrl = (id: number) => `/api/image-file/${id}`
export const convertedVideoUrl = (id: number) => `/api/videos/${id}/converted`
