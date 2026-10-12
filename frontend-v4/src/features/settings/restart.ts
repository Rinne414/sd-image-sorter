import { create } from 'zustand'
import { api, unwrap } from '../../api/client'
import { translate, useLang, type MessageKey, type Params } from '../../i18n'
import { useToasts } from '../../ui/toasts'
import { askWhenBusy, waitForNewBoot, type AskAction, type BootDeps } from './restartWait'

// Restarting the app and installing an update, shared by About & updates and
// (later) the Model Center. Both end the same way: a full-screen "restarting"
// until a server answers with a new boot id, then a reload; after three
// minutes the screen says what to do instead. RestartOverlay draws `screen`.

export type RestartScreen =
  | { kind: 'none' }
  /** "Restart?" or "Install now?": `jobs` null for the plain question, else the jobs it would stop. */
  | { kind: 'ask'; jobs: string[] | null; action: AskAction }
  | { kind: 'wait'; what: 'download' | 'update' | 'restart'; latest: string }
  | { kind: 'slow' }
  | { kind: 'unsupported' }

interface RestartState {
  screen: RestartScreen
  /** Answers the open question (true: go ahead). */
  answer: (go: boolean) => void
  /** Closes the "taking long" or "cannot restart" screen. */
  dismiss: () => void
}

let pending: ((go: boolean) => void) | null = null

export const useRestart = create<RestartState>((set) => ({
  screen: { kind: 'none' },
  answer: (go) => {
    set({ screen: { kind: 'none' } })
    pending?.(go)
    pending = null
  },
  dismiss: () => set({ screen: { kind: 'none' } }),
}))

const show = (screen: RestartScreen) => useRestart.setState({ screen })
const say = (key: MessageKey, params?: Params) => translate(useLang.getState().lang, key, params)
const toastError = (text: string) => useToasts.getState().push(text, 'error')

function ask(jobs: string[] | null, action: AskAction = 'restart'): Promise<boolean> {
  pending?.(false)
  return new Promise((resolve) => {
    pending = resolve
    show({ kind: 'ask', jobs, action })
  })
}

async function bootId(): Promise<string | null> {
  const res = unwrap<{ boot_id?: unknown }>(await api.GET('/api/updates/boot-id'))
  return typeof res.boot_id === 'string' ? res.boot_id : null
}

const REAL_SERVER: BootDeps = {
  fetchBootId: bootId,
  sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
  now: () => Date.now(),
}

/** Full screen until the new server answers, then reload; the "taking long" screen after three minutes. */
async function comeBack(previous: string | null, waiting: RestartScreen): Promise<void> {
  show(waiting)
  if (await waitForNewBoot(previous, REAL_SERVER)) window.location.reload()
  else show({ kind: 'slow' })
}

interface RestartAnswer {
  status?: string
  jobs?: unknown
  boot_id?: unknown
}

async function postRestart(reason: string, force: boolean): Promise<RestartAnswer> {
  return unwrap<RestartAnswer>(await api.POST('/api/updates/restart', { body: { reason, force } }))
}

export type RestartOutcome = 'restarting' | 'declined' | 'unsupported' | 'failed'

/**
 * Restart the app. Asks first (unless the caller's own button already was the
 * question); when jobs are running the backend names them and the user decides
 * whether to restart anyway.
 */
export async function restartApp({ reason = 'user', askFirst = true }: { reason?: string; askFirst?: boolean } = {}): Promise<RestartOutcome> {
  if (askFirst && !(await ask(null))) return 'declined'
  try {
    const result = await askWhenBusy((check) => postRestart(reason, !check), (jobs) => ask(jobs))
    if (!result) return 'declined'
    if (result.status !== 'scheduled') {
      show({ kind: 'unsupported' })
      return 'unsupported'
    }
    void comeBack(typeof result.boot_id === 'string' ? result.boot_id : null, { kind: 'wait', what: 'restart', latest: '' })
    return 'restarting'
  } catch (error) {
    toastError(say('restart.failed', { reason: (error as Error).message }))
    return 'failed'
  }
}

export type InstallOutcome = 'installing' | 'upToDate' | 'declined' | 'failed'

async function postApply(checkBusy: boolean): Promise<{ status?: string }> {
  const body = { force_check: true, relaunch: true, check_busy: checkBusy }
  return unwrap<{ status?: string }>(await api.POST('/api/updates/apply', { body }))
}

/**
 * Download and install `latest` (the user confirmed it). The request itself
 * downloads the package, so the "downloading" screen shows from the start.
 * Jobs running anywhere (another tab, V3.5) make the backend answer "busy"
 * before it downloads anything, and the user decides whether to install anyway.
 */
export async function installUpdate(latest: string): Promise<InstallOutcome> {
  const downloading = () => show({ kind: 'wait', what: 'download', latest })
  downloading()
  const before = await bootId().catch(() => null)
  try {
    const result = await askWhenBusy(postApply, async (jobs) => {
      const go = await ask(jobs, 'install')
      if (go) downloading()
      return go
    })
    if (!result) return 'declined'
    if (result.status !== 'scheduled') {
      show({ kind: 'none' })
      if (result.status === 'up_to_date') useToasts.getState().push(say('about.install.upToDate'))
      else toastError(say('about.install.failed', { reason: String(result.status ?? '') }))
      return result.status === 'up_to_date' ? 'upToDate' : 'failed'
    }
  } catch (error) {
    show({ kind: 'none' })
    toastError(say('about.install.failed', { reason: (error as Error).message }))
    return 'failed'
  }
  void comeBack(before, { kind: 'wait', what: 'update', latest })
  return 'installing'
}
