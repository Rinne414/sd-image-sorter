import type { HealthSample, LibraryHealth } from '../../api/types'

// Reads GET /api/library-health for the library status and its report.
// The sample-reason ladder and the issue order mirror the backend
// (db_facets.SAMPLE_REASON_LADDER / ISSUE_VOCABULARY), as V3.5's
// library-health.js did, so a listed file is only ever described as
// something the audit itself counts.

export type Verdict = 'empty' | 'good' | 'watch' | 'risk' | 'unknown'

/** Same cut-offs as V3.5's audit. */
const RISK_BELOW = 60
const WATCH_BELOW = 82

export function verdict(summary: { total_images: number; quality_score?: number }): Verdict {
  if (summary.total_images <= 0) return 'empty'
  const score = summary.quality_score
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'unknown'
  if (score < RISK_BELOW) return 'risk'
  if (score < WATCH_BELOW) return 'watch'
  return 'good'
}

/** Issue keys in the order the report draws them. */
export const ISSUE_KEYS = [
  'unreadable',
  'metadata_error',
  'metadata_pending',
  'missing_text',
  'sd_missing_checkpoint',
  'unattributed_sd_metadata',
  'missing_dimensions',
  'missing_file_size',
  'untagged',
  'missing_embedding',
  'missing_aesthetic',
] as const

export type IssueKey = (typeof ISSUE_KEYS)[number]

/** Optional coverage, not defects: shown even at zero so "complete" reads as such. */
const COVERAGE: ReadonlySet<IssueKey> = new Set(['missing_embedding', 'missing_aesthetic'])

export interface IssueRow {
  key: IssueKey
  count: number
  coverage: boolean
}

export function issueRows(counts: Record<string, number>): IssueRow[] {
  return ISSUE_KEYS.map((key) => ({ key, count: counts[key] ?? 0, coverage: COVERAGE.has(key) })).filter((r) => r.count > 0 || r.coverage)
}

export type ReasonKind =
  | 'unreadable'
  | 'metadata_error'
  | 'metadata_pending'
  | 'missing_text'
  | 'sd_missing_checkpoint'
  | 'unattributed_sd_metadata'
  | 'missing_dimensions'
  | 'untagged'
  | 'unnamed'

export type SampleReason = { kind: Exclude<ReasonKind, 'unreadable'> } | { kind: 'unreadable'; text: string }

const blank = (v: string | null | undefined) => v === null || v === undefined || v.trim() === ''
const genId = (s: HealthSample) => (s.generator ?? '').trim().toLowerCase()
/** Ids the parser records when no SD tool claimed the image (db_helpers.UNATTRIBUTED_GENERATORS). */
const UNATTRIBUTED = ['unknown', 'others']
/** No generator recorded at all (db_helpers.NO_GENERATOR_RECORDED_SQL). */
const NO_GENERATOR = ['', 'unknown']
const status = (s: HealthSample) => (s.metadata_status ?? '').trim().toLowerCase()

const LADDER: [Exclude<ReasonKind, 'unnamed'>, (s: HealthSample) => boolean][] = [
  // read_error stands in for is_readable = 0, which the payload does not carry.
  ['unreadable', (s) => !blank(s.read_error)],
  ['metadata_error', (s) => status(s) === 'error'],
  ['metadata_pending', (s) => status(s) === 'pending'],
  ['missing_text', (s) => blank(s.prompt) && blank(s.sidecar_caption)],
  ['sd_missing_checkpoint', (s) => blank(s.checkpoint_normalized) && !blank(s.generator) && !UNATTRIBUTED.includes(genId(s))],
  ['unattributed_sd_metadata', (s) => NO_GENERATOR.includes(genId(s)) && (!blank(s.prompt) || !blank(s.checkpoint_normalized))],
  ['missing_dimensions', (s) => !s.width || !s.height],
  ['untagged', (s) => !s.tagged_at],
]

const leaf = (p: string) => p.split(/[\\/]+/).filter(Boolean).at(-1) ?? p

/** Old rows quote absolute paths in their read error; keep only the file name. */
export function cleanReadError(raw: string): string {
  const text = raw
    .replace(/(['"])([^'"]*[\\/][^'"]*)\1/g, (_m, q: string, p: string) => q + leaf(p) + q)
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s'"]*/g, leaf)
    .replace(/(^|[^A-Za-z0-9_~])(\/(?:[^\s'"/]+\/)+[^\s'"]*)/g, (_m, pre: string, p: string) => pre + leaf(p))
    .replace(/\s+/g, ' ')
    .trim()
  return text || raw
}

export function sampleReason(s: HealthSample): SampleReason {
  for (const [kind, test] of LADDER) {
    if (!test(s)) continue
    return kind === 'unreadable' ? { kind, text: cleanReadError(s.read_error ?? '') } : { kind }
  }
  return { kind: 'unnamed' }
}

/**
 * Readable images whose generation details failed to read. Every unreadable
 * row is also a read-error row, and the unreadable ones are the missing-files
 * row's business, so this is the union the report publishes minus them.
 */
export function readErrorsOnly(report: LibraryHealth): number {
  const c = report.issue_counts
  const unreadable = c.unreadable ?? 0
  const union = report.recommendations?.find((r) => r.kind === 'reparse_or_reconnect')?.count
  const n = union !== undefined ? union - unreadable : (c.metadata_error ?? 0) - unreadable
  return Math.max(0, n)
}

export type StepKind = 'pending' | 'missing' | 'readErrors' | 'missingText' | 'checkpoint' | 'unattributed' | 'incomplete' | 'untagged' | 'duplicates'

export interface Step {
  kind: StepKind
  n: number
  warn: boolean
}

/** The backend's remedies (ISSUE_REMEDIES order), one step each; "re-parse or reconnect" is two fixes. */
const REMEDY_STEP: Record<string, StepKind | undefined> = {
  metadata_pending: 'pending',
  missing_text: 'missingText',
  sd_missing_checkpoint: 'checkpoint',
  unattributed_sd_metadata: 'unattributed',
  incomplete_scan_record: 'incomplete',
  untagged: 'untagged',
  duplicate_filenames: 'duplicates',
}

/**
 * What to do next, each with its count. `missing` is the live missing-files
 * count (the report is cached for a minute). Without the backend's remedy
 * list (an older or stubbed report) the steps come from the issue counts.
 */
export function nextSteps(report: LibraryHealth, missing: number): Step[] {
  const c = report.issue_counts
  const recs = report.recommendations
  const steps: Step[] = []
  const push = (kind: StepKind, n: number, warn: boolean) => {
    if (n > 0) steps.push({ kind, n, warn })
  }
  if (!recs) {
    push('missing', missing, true)
    push('readErrors', readErrorsOnly(report), true)
    push('missingText', c.missing_text ?? 0, false)
    push('untagged', c.untagged ?? 0, false)
    return steps
  }
  for (const r of recs) {
    if (r.kind === 'reparse_or_reconnect') {
      push('missing', missing, true)
      push('readErrors', readErrorsOnly(report), true)
      continue
    }
    const kind = REMEDY_STEP[r.kind]
    if (kind) push(kind, r.count, r.severity === 'warning')
  }
  // Files that went missing after the report was made still need their fix.
  if (!steps.some((s) => s.kind === 'missing')) push('missing', missing, true)
  return steps
}

/**
 * The rail offers "recover missing text" until a run has tried; after that
 * only when more images lack text than the last run left (new imports).
 */
export function shouldOfferTextRecovery(missingText: number, leftByLastRun: number | undefined): boolean {
  if (missingText <= 0) return false
  return leftByLastRun === undefined || missingText > leftByLastRun
}
