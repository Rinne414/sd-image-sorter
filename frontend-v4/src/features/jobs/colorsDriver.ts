import { api, unwrap } from '../../api/client'
import { rawJson } from '../../api/raw'

// Polls, pauses, resumes and stops colour analysis for the Jobs drawer (read
// by colorsJob.ts). Pause and resume are not in the generated schema, so they
// go through api/raw.ts.

type Raw = Record<string, unknown>

export const driveColors = {
  poll: async (): Promise<unknown> => unwrap(await api.GET('/api/colors/progress')),
  cancel: async (): Promise<unknown> => unwrap(await api.POST('/api/colors/cancel')),
  pause: {
    pause: async (): Promise<unknown> => rawJson<Raw>('POST', '/api/colors/pause'),
    resume: async (): Promise<unknown> => rawJson<Raw>('POST', '/api/colors/resume'),
  },
}
