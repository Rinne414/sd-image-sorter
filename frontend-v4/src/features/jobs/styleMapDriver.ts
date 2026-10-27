import { rawJson } from '../../api/raw'
import { readProgress } from './progress'

// Polls, pauses, resumes and stops the Style Map's index job for the Jobs
// drawer (read by styleMapJob.ts). The routes are not in the generated
// schema, so they go through api/raw.ts.

type Raw = Record<string, unknown>

const BASE = '/api/style-map/vectors'

export const driveStyleMap = {
  poll: async (): Promise<unknown> => rawJson<Raw>('GET', `${BASE}/progress`),
  cancel: async (): Promise<unknown> => rawJson<Raw>('POST', `${BASE}/cancel`, { body: {} }),
  pause: {
    pause: async (): Promise<unknown> => rawJson<Raw>('POST', `${BASE}/pause`, { body: {} }),
    resume: async (): Promise<unknown> => rawJson<Raw>('POST', `${BASE}/resume`, { body: {} }),
  },
}

/** An index job already going when V Opus opened (a reload, or the classic page started it). */
export function adoptStyleMap(raw: Raw) {
  if (raw.running !== true) return null
  const progress = readProgress('stylemap', raw)
  return { kind: 'stylemap' as const, progress, count: progress.total }
}
