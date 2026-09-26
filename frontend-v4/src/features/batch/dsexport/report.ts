import { folderKey, libraryKey, pathKey } from '../datasetItems'
import type { Entry } from '../entries'

// What the backend's check (Readiness) and export send back, read for the
// export step: issues grouped by what the user can do about them, the image a
// refused check named, and the export's result.

export interface ReadinessIssue {
  severity: 'blocker' | 'warning'
  code: string
  message: string
  image_id: number | null
  source_path: string | null
  destination: string | null
}

export interface ReadinessReport {
  report_id: string
  input_fingerprint: string
  summary: {
    status: 'ready' | 'warnings' | 'blocked'
    total_requested: number
    processed: number
    trainable_pairs: number
    blocker_count: number
    warning_count: number
    skippable_items: number
    empty_caption_items: number
  }
  issues: ReadinessIssue[]
  total_issues: number
  issues_truncated: boolean
}

/** What the export step calls each backend issue code (codes it does not know read as "other"). */
export type IssueLabel =
  | 'unreadable'
  | 'emptyCaption'
  | 'renderFailed'
  | 'nameClash'
  | 'existsSkipped'
  | 'overwritesSource'
  | 'duplicate'
  | 'noMask'
  | 'nothingLeft'
  | 'dialect'
  | 'multiline'
  | 'missingTrigger'
  | 'ratings'
  | 'selection'
  | 'other'

const LABELS: Record<string, IssueLabel> = {
  source_unreadable: 'unreadable',
  empty_caption: 'emptyCaption',
  caption_render_failed: 'renderFailed',
  caption_destination_collision: 'nameClash',
  mask_destination_collision: 'nameClash',
  unpaired_output: 'nameClash',
  unpaired_sidecar: 'nameClash',
  existing_output_skipped: 'existsSkipped',
  source_destination_alias: 'overwritesSource',
  transform_source_destination_alias: 'overwritesSource',
  mask_source_destination_alias: 'overwritesSource',
  duplicate_source: 'duplicate',
  subject_crop_mask_invalid: 'noMask',
  bucket_resize_mask_invalid: 'noMask',
  zero_trainable_pairs: 'nothingLeft',
  caption_dialect_mismatch: 'dialect',
  caption_dialect_partial: 'dialect',
  multiline_caption: 'multiline',
  missing_trigger: 'missingTrigger',
  conflicting_ratings: 'ratings',
  annotation_selection_missing: 'selection',
  annotation_selection_extra: 'selection',
}

export const issueLabel = (code: string): IssueLabel => LABELS[code] ?? (code.includes('mask') ? 'noMask' : 'other')

/** Labels the caption editor can fix. */
export const CAPTION_LABELS: ReadonlySet<IssueLabel> = new Set(['emptyCaption', 'renderFailed', 'multiline', 'missingTrigger', 'ratings', 'dialect'])

export interface IssueGroup {
  label: IssueLabel
  severity: 'blocker' | 'warning'
  /** Entry keys of the batch images it names (for "take out" and "open in the editor"). */
  keys: string[]
  names: string[]
  /** Issues in the group (a skipped one counts as its image's). */
  count: number
  /** The backend's own words for the first one (shown on hover). */
  detail: string
}

const tail = (path: string) => path.split(/[\\/]/).pop() || path

/** Group issues by what they are, blockers first; each names the batch images it is about. */
export function groupIssues(issues: readonly ReadinessIssue[], entries: readonly Entry[]): IssueGroup[] {
  const byPath = new Map(entries.flatMap((e) => (e.path ? [[pathKey(e.path).toLowerCase(), e] as const] : [])))
  const byId = new Map(entries.flatMap((e) => (e.imageId !== null ? [[e.imageId, e] as const] : [])))
  const groups = new Map<string, IssueGroup>()
  for (const issue of issues) {
    const label = issueLabel(issue.code)
    const id = `${issue.severity}:${label}`
    const group = groups.get(id) ?? { label, severity: issue.severity, keys: [], names: [], count: 0, detail: issue.message }
    const entry = (issue.image_id !== null ? byId.get(issue.image_id) : undefined) ?? (issue.source_path ? byPath.get(pathKey(issue.source_path).toLowerCase()) : undefined)
    const name = entry?.filename ?? (issue.source_path ? tail(issue.source_path) : '')
    const key = entry?.key ?? null
    groups.set(id, {
      ...group,
      count: group.count + 1,
      keys: key && !group.keys.includes(key) ? [...group.keys, key] : group.keys,
      names: name && !group.names.includes(name) ? [...group.names, name] : group.names,
    })
  }
  return [...groups.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'blocker' ? -1 : 1))
}

/**
 * The batch image a refused check names. The backend refuses the whole
 * request for an image whose caption it cannot bind to the file as it is now
 * (`AnnotationSelectionResolutionError: ... key='12'` or `key='C:\\a.png'`,
 * a Python repr). Null when the message names none.
 */
export function refusedKey(message: string): string | null {
  const match = /key=(['"])((?:\\.|(?!\1).)*)\1/.exec(message)
  if (!match) return null
  const raw = (match[2] ?? '').replace(/\\(['"\\])/g, '$1')
  if (!raw) return null
  return /^\d+$/.test(raw) ? libraryKey(Number(raw)) : folderKey(raw)
}

export interface ExportResultItem {
  image_id: number
  src_image_path: string | null
  dst_image_path: string | null
  dst_caption_path: string | null
  skipped_reason: string | null
  error: string | null
}

/** POST /api/dataset/export(/start)'s DatasetExportResponse. */
export interface DatasetExportResult {
  status: 'ok' | 'partial' | 'failed' | 'cancelled'
  exported: number
  skipped: number
  error_count: number
  masks_written: number
  masks_missing: number
  trainer_config_path: string | null
  output_folder: string
  output_mode: string
  items: ExportResultItem[]
  total_items: number
  items_truncated: boolean
  error_messages: string[]
  warnings: { code: string; message: string; backup_path: string }[]
  package_status: 'not_requested' | 'complete' | 'incomplete'
}

export const fileName = tail
