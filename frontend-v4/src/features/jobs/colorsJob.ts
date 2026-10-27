import { translate, useLang } from '../../i18n'
import type { JobProgress } from './progress'

// Reads colour analysis for the Jobs drawer: GET /api/colors/progress answers a
// running flag instead of a status word, a paused flag, `completed` and `failed`
// counts of `total` and the file in hand. colorsDriver.ts polls, pauses,
// resumes and stops it.

type Raw = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

export function readColors(base: JobProgress, raw: Raw): JobProgress {
  const running = raw.running === true
  // The backend keeps the stop it was asked for until the next run starts: a run that ended after one was stopped.
  const stopped = raw.cancel_requested === true
  const status = running ? (stopped ? 'cancelling' : 'running') : stopped ? 'cancelled' : 'done'
  const completed = num(raw.completed)
  const failed = num(raw.failed)
  const paused = running && raw.paused === true
  return {
    ...base,
    status,
    current: completed + failed,
    total: num(raw.total),
    succeeded: completed,
    failedCount: failed,
    paused,
    currentItem: paused ? translate(useLang.getState().lang, 'partialsa.colors.pausedItem') : str(raw.current_image) || null,
    message: '',
  }
}
