import { translate, useLang, type MessageKey, type Params } from '../../i18n'
import { installFailureText } from '../video/installError'
import type { JobProgress } from './progress'

// Reads the video support install for the Jobs drawer: GET /api/video-support
// answers { available, install: { state, phase, downloaded, total, error } }.
// The backend downloads on its own thread and cannot stop it, so no Stop.

type Raw = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {})

const say = (key: MessageKey, params?: Params) => translate(useLang.getState().lang, key, params)

export function readVideoInstall(base: JobProgress, raw: Raw): JobProgress {
  const install = obj(raw.install)
  const state = str(install.state)
  const shown = { ...base, unit: 'bytes' as const, current: num(install.downloaded), total: num(install.total) }
  if (state === 'running') {
    const phase = str(install.phase)
    const currentItem = phase === 'unpacking' ? say('video.statusUnpacking') : phase === 'looking' ? say('video.statusLooking') : null
    return { ...shown, status: 'running', currentItem, message: '' }
  }
  if (state === 'failed') {
    const message = installFailureText({ code: str(install.error_code), params: obj(install.error_params), message: str(install.error) }, say)
    return { ...shown, status: 'error', currentItem: null, message }
  }
  if (raw.available === true) return { ...shown, status: 'done', succeeded: 1, currentItem: null, message: '' }
  // Idle and still not installed: the backend restarted and forgot the run.
  return { ...shown, status: 'error', current: 0, total: 0, currentItem: null, message: '', lost: true }
}

/** A run already going when V4 opened (a reload, or the classic page started it). */
export function adoptVideoInstall(raw: Raw) {
  if (str(obj(raw.install).state) !== 'running') return null
  return { kind: 'video' as const, progress: readVideoInstall({ ...EMPTY }, raw), label: null as string | null }
}

const EMPTY: JobProgress = {
  status: 'running',
  current: 0,
  total: 0,
  unit: 'bytes',
  succeeded: 0,
  failedCount: 0,
  failures: [],
  alreadyGone: 0,
  topTags: [],
  needsRestart: false,
  restartAdvised: false,
  toReview: 0,
  phase: null,
  updated: 0,
  currentItem: null,
  message: '',
}

/** The reading right after the install was asked for (POST answers with the install's own state). */
export function startedVideoInstall(install: Raw): JobProgress {
  return readVideoInstall({ ...EMPTY }, { install, available: false })
}
