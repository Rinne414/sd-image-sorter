import { translate, useLang } from '../../i18n'
import { useToasts } from '../../ui/toasts'

// After an update, say once what changed: the running version's summary from
// its release notes (GET /api/updates/whats-new), in the UI language, with a
// link to the full notes. Classic does the same (frontend/js/whats-new.js) and
// both read and write the same remembered version, so one notice covers both.

export const SEEN_KEY = 'sd-whats-new-seen-version'
// Automated browsers (browser tests) skip it unless a test opts in.
const AUTOMATION_OPT_IN_KEY = 'sd-whats-new-in-automation'
const DELAY_MS = 2500
const SHOW_MS = 15000

export interface WhatsNew {
  available: boolean
  version: string
  summary_zh: string
  summary_en: string
  notes_url: string
  updated: boolean
}

/** Whether to show the notice: a version this window saw before, or the backend saw an older run. */
export function shouldShowWhatsNew(seen: string | null, state: WhatsNew): boolean {
  if (!state.available || seen === state.version) return false
  return Boolean(seen) || state.updated
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

async function check(): Promise<void> {
  if (navigator.webdriver && stored(AUTOMATION_OPT_IN_KEY) !== '1') return
  let state: WhatsNew | null = null
  try {
    const response = await fetch('/api/updates/whats-new', { headers: { Accept: 'application/json' } })
    state = response.ok ? ((await response.json()) as WhatsNew) : null
  } catch {
    state = null
  }
  if (!state?.version) return
  const seen = stored(SEEN_KEY)
  try {
    localStorage.setItem(SEEN_KEY, state.version)
  } catch {
    // Blocked storage: the notice may show again, nothing breaks.
  }
  if (!shouldShowWhatsNew(seen, state)) return
  const lang = useLang.getState().lang
  const summary = lang === 'zh-CN' ? state.summary_zh || state.summary_en : state.summary_en || state.summary_zh
  if (!summary) return
  const url = state.notes_url
  useToasts.getState().push(
    translate(lang, 'whatsNew.toast', { version: state.version, summary }),
    'info',
    { label: translate(lang, 'whatsNew.fullNotes'), run: () => window.open(url, '_blank', 'noopener') },
    SHOW_MS,
  )
}

/** Looks once, shortly after the program opens; returns the cleanup. */
export function startWhatsNew(): () => void {
  const timer = window.setTimeout(() => void check(), DELAY_MS)
  return () => window.clearTimeout(timer)
}
