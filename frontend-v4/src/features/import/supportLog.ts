import { api, unwrap } from '../../api/client'
import { copyText } from '../../lib/format'
import { useToasts } from '../../ui/toasts'
import { tr } from '../jobs/jobs'

// The support log, for an import that looks stuck: copy a diagnostics bundle
// (recent log lines, already redacted by the backend), open the log's folder,
// or copy its path. Same text as V3.5, so support reads one format.

interface Diagnostics {
  app_version?: string
  log_file_path?: string
  log_file_path_redacted?: string
  log_file_exists?: boolean
  access_log_enabled?: boolean
  log_level?: string
  recent_log_text?: string
}

/** Lines of the backend log in a copied bundle. */
export const LOG_LINES = 200

/** `extra`: more lines after the version (About › Support adds the hardware and the update check). */
export function formatDiagnostics(d: Diagnostics, { title = 'SD Image Sorter scan diagnostics', extra = [] as string[] } = {}): string {
  return [
    title,
    `App version: ${d.app_version || 'unknown'}`,
    ...extra,
    `Log file: ${d.log_file_path_redacted || (d.log_file_path ? '<PATH>' : 'unavailable')}`,
    `Log exists: ${d.log_file_exists ? 'yes' : 'no'}`,
    `Access log: ${d.access_log_enabled ? 'on' : 'off'}`,
    `Log level: ${d.log_level || 'unknown'}`,
    '',
    'Recent backend log:',
    d.recent_log_text || '(no log lines available)',
  ].join('\n')
}

const say = (text: string, tone: 'info' | 'error' = 'info') => useToasts.getState().push(text, tone)

export async function diagnostics(lines: number): Promise<Diagnostics | null> {
  try {
    return unwrap<Diagnostics>(await api.GET('/api/support/diagnostics', { params: { query: { lines } } }))
  } catch (error) {
    say(tr('import.diag.loadFailed', { reason: (error as Error).message }), 'error')
    return null
  }
}

export async function copyDiagnostics(): Promise<void> {
  const d = await diagnostics(LOG_LINES)
  if (!d) return
  const ok = await copyText(formatDiagnostics(d))
  say(ok ? tr('import.diag.copied') : tr('lib.copy.failed'), ok ? 'info' : 'error')
}

export async function copyLogPath(): Promise<void> {
  const d = await diagnostics(1)
  if (!d) return
  if (!d.log_file_path) {
    say(tr('import.diag.noLogPath'), 'error')
    return
  }
  const ok = await copyText(d.log_file_path)
  say(ok ? tr('import.diag.pathCopied') : tr('lib.copy.failed'), ok ? 'info' : 'error')
}

export async function openLog(): Promise<void> {
  try {
    const res = unwrap<{ opened?: boolean; path_redacted?: string }>(await api.POST('/api/support/open-log'))
    if (res.opened === false) say(tr('import.diag.openUnavailable', { path: res.path_redacted ?? '' }), 'error')
  } catch (error) {
    say(tr('import.diag.openFailed', { reason: (error as Error).message }), 'error')
  }
}
