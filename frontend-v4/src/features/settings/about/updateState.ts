// What the update check found, read into the few states the About tab and the
// top bar show. Pure: no requests, no storage.
//
// V3.5 showed "Latest: <current version>" before anything was checked and after
// a failed check (the backend fills latest_version with the current one when it
// knows nothing). Here an unchecked or failed check never says "latest".

export interface UpdateAsset {
  name?: string
  size_bytes?: number | null
}

/** GET /api/updates/status (services/update_service_delivery.py `_build_status`). */
export interface UpdateStatus {
  current_version?: string
  latest_version?: string
  has_update?: boolean
  release_url?: string | null
  release_notes?: string | null
  asset?: UpdateAsset | null
  error?: string | null
  update_unavailable_reason?: string | null
  is_default_github_channel?: boolean
  /** Seconds since the epoch. */
  checked_at?: number
}

export type UpdateView =
  | { kind: 'unchecked' }
  /** `defaultChannel`: the official GitHub source (else the user's proxy). */
  | { kind: 'error'; reason: string; defaultChannel: boolean }
  | { kind: 'latest'; current: string; checkedAt: number | null; defaultChannel: boolean }
  | { kind: 'available'; current: string; latest: string; notes: string; url: string | null; sizeBytes: number | null }
  /** Newer, but this channel has no in-app package for this computer: download it by hand. */
  | { kind: 'manual'; current: string; latest: string; notes: string; url: string | null }

/** A web link the page may open: http(s) only. */
export function webLink(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null
}

export function readUpdate(status: UpdateStatus | null): UpdateView {
  if (!status) return { kind: 'unchecked' }
  const defaultChannel = status.is_default_github_channel !== false
  if (status.error) return { kind: 'error', reason: status.error, defaultChannel }
  const current = status.current_version ?? ''
  const latest = status.latest_version ?? current
  const notes = status.release_notes ?? ''
  const url = webLink(status.release_url)
  if (status.has_update) return { kind: 'available', current, latest, notes, url, sizeBytes: status.asset?.size_bytes ?? null }
  if (status.update_unavailable_reason) return { kind: 'manual', current, latest, notes, url }
  return { kind: 'latest', current, checkedAt: status.checked_at ?? null, defaultChannel }
}

/** The version the top bar names ("新版本 x.y.z"), or null when there is none to name. */
export function hintVersion(status: UpdateStatus | null): string | null {
  const view = readUpdate(status)
  return view.kind === 'available' || view.kind === 'manual' ? view.latest : null
}

/** Release notes as plain text: no heading marks or bold marks, no runs of blank lines. */
export function plainNotes(notes: string): string {
  return notes
    .replace(/\r\n?/g, '\n')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** How much of the notes the About tab shows before "Show all". */
export const NOTES_LEAD = 200

const CJK_END = '。！？…'
const LATIN_END = '.!?'

/** Where the last sentence that fits in `max` characters ends (exclusive), or 0. */
function lastSentenceEnd(text: string, max: number): number {
  let end = 0
  for (let i = 0; i < Math.min(max, text.length); i++) {
    const ch = text[i]!
    if (ch === '\n') end = i
    else if (CJK_END.includes(ch)) end = i + 1
    else if (LATIN_END.includes(ch) && (i + 1 === text.length || /\s/.test(text[i + 1]!))) end = i + 1
  }
  return end
}

/**
 * The start of the release notes: the summary above the first "---" rule (how
 * releases are written) or the whole text; if that is longer than `max`
 * characters, up to the last sentence end that fits (else the last space, with "…").
 */
export function notesLead(notes: string, max = NOTES_LEAD): { lead: string; more: boolean } {
  const text = plainNotes(notes)
  const head = text.split(/\n-{3,}\s*(?:\n|$)/)[0]!.trimEnd()
  if (head.length <= max) return { lead: head, more: head.length < text.length }
  const end = lastSentenceEnd(head, max)
  if (end > 0) return { lead: head.slice(0, end).trimEnd(), more: true }
  const cut = head.slice(0, max)
  const space = cut.search(/\s\S*$/)
  return { lead: (space > 0 ? cut.slice(0, space) : cut).trimEnd() + '…', more: true }
}

/** localStorage: "0" when the user switched the check after start off. */
export const AUTO_CHECK_KEY = 'sd-v4-update-autocheck'

export function readAutoCheck(raw: string | null): boolean {
  return raw !== '0'
}
