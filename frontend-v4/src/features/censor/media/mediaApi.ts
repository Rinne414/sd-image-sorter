import { rawJson } from '../../../api/raw'
import type { MediaStartBody } from './mediaBody'

// The GIF and video censor's routes (/api/censor/media/*). They are not in the
// generated schema, so they go through rawJson.

export interface MediaListing {
  gifs: string[]
  videos: string[]
  /** ffmpeg is installed, so videos can be processed. */
  video_ready: boolean
}

/** Which ffmpeg video censoring would use: video support's, imageio-ffmpeg's, or none (video support is then offered). */
export interface MediaStatus {
  video_ready: boolean
  video_source: 'video_support' | 'imageio' | 'path' | null
}

export const mediaStatusQuery = {
  queryKey: ['media-censor-status'],
  queryFn: ({ signal }: { signal?: AbortSignal }) => rawJson<MediaStatus>('GET', '/api/censor/media/status', { signal }),
  staleTime: 5_000,
}

export interface MediaStarted {
  job_id: string
  output_folder: string
}

export const listMedia = (folder: string, signal?: AbortSignal) => rawJson<MediaListing>('POST', '/api/censor/media/list', { body: { folder }, signal })

export const startMedia = (body: MediaStartBody) => rawJson<MediaStarted>('POST', '/api/censor/media/start', { body })

const jobUrl = (id: string) => `/api/censor/media/jobs/${encodeURIComponent(id)}`

export const getMediaJob = (id: string) => rawJson<unknown>('GET', jobUrl(id))

export const cancelMedia = (id: string) => rawJson<unknown>('POST', `${jobUrl(id)}/cancel`, { body: {} })

/** Show the finished file `index` of the job in the file manager. */
export const revealMedia = (id: string, index: number) => rawJson<unknown>('POST', `${jobUrl(id)}/reveal/${index}`, { body: {} })
