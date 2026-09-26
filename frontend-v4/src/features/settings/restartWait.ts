import type { Lang, MessageKey } from '../../i18n'

// Waiting for the app to come back after a restart or an update, and asking
// first, in plain names, about the jobs a restart or an install would stop.
// Pure: the server and the clock are passed in (restart.ts gives the real ones).

/** How long a restart or an update may take before the page says what to do. */
export const RESTART_WAIT_MS = 180_000
const LOOK_EVERY_MS = 1_000

export interface BootDeps {
  /** The running server's boot id (GET /api/updates/boot-id); throws while no server answers. */
  fetchBootId: () => Promise<string | null>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

/**
 * Resolves true once a server answers with a boot id other than `previous`
 * (a new process), false after RESTART_WAIT_MS. Without the old id, a server
 * counts as new only after one look found none (the old one went away).
 */
export async function waitForNewBoot(previous: string | null, deps: BootDeps, limitMs = RESTART_WAIT_MS): Promise<boolean> {
  const deadline = deps.now() + limitMs
  let wentAway = false
  while (deps.now() < deadline) {
    await deps.sleep(LOOK_EVERY_MS)
    let id: string | null = null
    try {
      id = await deps.fetchBootId()
    } catch {
      // the old server has stopped and the new one is not up yet
      wentAway = true
      continue
    }
    if (id && (previous ? id !== previous : wentAway)) return true
  }
  return false
}

/** The job ids POST /api/updates/restart and /apply answer with when busy (services/busy_jobs.py). */
const JOB_NAMES: Record<string, MessageKey> = {
  scan: 'restart.job.scan',
  tagging: 'restart.job.tagging',
  captions: 'restart.job.captions',
  aesthetic: 'restart.job.aesthetic',
  file_moves: 'restart.job.fileMoves',
  background_jobs: 'restart.job.background',
  model_setup: 'restart.job.modelSetup',
  ai: 'restart.job.ai',
}

/** "文件夹扫描、打标签": each running job once, in plain words. */
export function busyJobsText(jobs: unknown, t: (key: MessageKey) => string, lang: Lang): string {
  if (!Array.isArray(jobs)) return ''
  const names = jobs.map((id) => t(JOB_NAMES[String(id)] ?? 'restart.job.background'))
  return [...new Set(names)].join(lang === 'zh-CN' ? '、' : ', ')
}

/** The job ids of a "busy" answer from POST /api/updates/restart or /apply; null when the answer is not busy. */
export function busyJobs(answer: unknown): string[] | null {
  if (!answer || typeof answer !== 'object') return null
  const { status, jobs } = answer as { status?: unknown; jobs?: unknown }
  if (status !== 'busy') return null
  return Array.isArray(jobs) ? jobs.map(String) : []
}

/**
 * Send a request that answers "busy" while jobs run (restart, install): first
 * with the check on; when busy, ask the user with the running jobs, and send it
 * again with the check off only if they go ahead. Null: the user said no.
 */
export async function askWhenBusy<A>(send: (check: boolean) => Promise<A>, ask: (jobs: string[]) => Promise<boolean>): Promise<A | null> {
  const first = await send(true)
  const jobs = busyJobs(first)
  if (jobs === null) return first
  return (await ask(jobs)) ? send(false) : null
}

export type AskAction = 'restart' | 'install'

interface AskKeys {
  title: MessageKey
  body: MessageKey
  ok: MessageKey
}

const ASK_KEYS: Record<AskAction | 'plain', AskKeys> = {
  plain: { title: 'restart.ask.title', body: 'restart.ask.body', ok: 'restart.ask.ok' },
  restart: { title: 'restart.busy.title', body: 'restart.busy.body', ok: 'restart.busy.ok' },
  install: { title: 'about.install.busy.title', body: 'about.install.busy.body', ok: 'about.install.busy.ok' },
}

/**
 * The words of the question before a restart or an install; `busy` when the
 * backend named running jobs. Only a restart asks without jobs (an install's
 * own question is the install dialog).
 */
export function askKeys(action: AskAction, busy: boolean): AskKeys {
  return busy ? ASK_KEYS[action] : ASK_KEYS.plain
}
