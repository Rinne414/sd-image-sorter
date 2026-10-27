import { rawJson } from '../../api/raw'

// Polls the video support install for the Jobs drawer (read by videoJob.ts).
// The backend cannot stop the download, so the drawer offers no Stop.

export const driveVideo = {
  poll: async (): Promise<unknown> => rawJson('GET', '/api/video-support'),
  cancel: null,
}
