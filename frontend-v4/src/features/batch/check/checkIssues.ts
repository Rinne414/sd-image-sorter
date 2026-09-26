import { pathKey } from '../datasetItems'
import type { Entry } from '../entries'

// The check step's one list of issues. Each source (the project itself, the
// final captions, the review queue, the audit, health by purpose, character
// purity) says what it found by entry key; mergeIssues makes one issue per
// kind out of them: every image once, in batch order. Pure: no requests.

export type IssueKind =
  | 'file_changed'
  | 'file_missing'
  | 'unreadable'
  | 'empty_caption'
  | 'trigger_missing'
  | 'trigger_coverage'
  | 'trigger_collision'
  | 'duplicates'
  | 'small'
  | 'low_aesthetic'
  | 'too_long'
  | 'character_outlier'
  | 'fullbody'
  | 'rating_conflict'
  | 'rating_missing'
  | 'rare_tags'
  | 'cooccur'
  | 'health_other'

export type Severity = 'high' | 'medium' | 'low'
export type IssueSource = 'project' | 'captions' | 'review' | 'audit' | 'health' | 'purity'

export interface TagPair {
  a: string
  b: string
  /** Captions that have both. */
  together: number
  /** together / captions that have either. */
  ratio: number
}

export interface CheckIssue {
  /** One per kind, except health findings V4 has no words for (`health:<id>`). */
  id: string
  kind: IssueKind
  severity: Severity
  /** The images it is about, in batch order; empty for a finding about the whole set. */
  keys: string[]
  /** duplicates: the images that look alike, group by group. */
  groups?: string[][]
  /** rare_tags: the tags. */
  tags?: string[]
  /** cooccur: tags that go together. */
  pairs?: TagPair[]
  /** A short fact per image (a size, a token count, a score). */
  notes?: Record<string, string>
  params?: Record<string, number>
  /** health_other: the backend's own words. */
  text?: { en: string; zh: string; detailEn: string; detailZh: string }
  sources: IssueSource[]
}

const SEVERITY: Record<IssueKind, Severity> = {
  file_changed: 'high',
  file_missing: 'high',
  unreadable: 'high',
  empty_caption: 'high',
  trigger_missing: 'high',
  trigger_coverage: 'high',
  trigger_collision: 'high',
  duplicates: 'medium',
  small: 'medium',
  low_aesthetic: 'medium',
  too_long: 'medium',
  character_outlier: 'medium',
  fullbody: 'medium',
  rating_conflict: 'medium',
  rating_missing: 'low',
  rare_tags: 'low',
  cooccur: 'low',
  health_other: 'low',
}

const KIND_ORDER = Object.keys(SEVERITY) as IssueKind[]
const SEVERITY_ORDER: Severity[] = ['high', 'medium', 'low']

/** Issues about the whole set: they stand without images. */
const SET_KINDS: ReadonlySet<IssueKind> = new Set(['trigger_missing', 'trigger_collision', 'fullbody', 'rare_tags', 'cooccur', 'health_other'])

export function issue(kind: IssueKind, source: IssueSource, fields: Partial<CheckIssue> = {}): CheckIssue {
  return { id: kind, kind, severity: SEVERITY[kind], keys: [], sources: [source], ...fields }
}

/** Finds entries by Library id or by folder path (any slashes, any letter case: Windows paths). */
export interface KeyIndex {
  byId: ReadonlyMap<number, string>
  byPath: ReadonlyMap<string, string>
}

const foldPath = (path: string) => pathKey(path).toLowerCase()

export function keyIndex(entries: readonly Entry[]): KeyIndex {
  const byId = new Map<number, string>()
  const byPath = new Map<string, string>()
  for (const e of entries) {
    if (e.ref.kind === 'library') byId.set(e.ref.imageId, e.key)
    else byPath.set(foldPath(e.ref.path), e.key)
  }
  return { byId, byPath }
}

function lookup(index: KeyIndex, imageId: number, path: string | null | undefined): string | null {
  if (imageId > 0) return index.byId.get(imageId) ?? null
  return path ? (index.byPath.get(foldPath(path)) ?? null) : null
}

const present = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined

// ---- the project -------------------------------------------------------------

/** Folder images whose file changed since they were added (the export refuses them), and gone images. */
export function projectIssues(entries: readonly Entry[]): CheckIssue[] {
  const changed = entries.filter((e) => e.status === 'changed').map((e) => e.key)
  const missing = entries.filter((e) => e.status === 'missing').map((e) => e.key)
  return [
    ...(changed.length ? [issue('file_changed', 'project', { keys: changed })] : []),
    ...(missing.length ? [issue('file_missing', 'project', { keys: missing })] : []),
  ]
}

// ---- the review queue (Library images, stored evidence) ---------------------------

export interface ReviewIssueRow {
  issue_id: string
  kind: 'file_missing' | 'image_unreadable' | 'small_image' | 'low_aesthetic' | 'duplicate_group' | 'rating_conflict' | string
  subjects: { image_id: number }[]
  evidence: { label_en: string; value_en: string }[]
}

const REVIEW_KINDS: Record<string, IssueKind> = {
  file_missing: 'file_missing',
  image_unreadable: 'unreadable',
  small_image: 'small',
  low_aesthetic: 'low_aesthetic',
  duplicate_group: 'duplicates',
  rating_conflict: 'rating_conflict',
}

export function reviewIssues(rows: readonly ReviewIssueRow[], index: KeyIndex): CheckIssue[] {
  const out: CheckIssue[] = []
  for (const row of rows) {
    const kind = REVIEW_KINDS[row.kind]
    if (!kind) continue
    const keys = row.subjects.map((s) => lookup(index, s.image_id, null)).filter(present)
    if (keys.length === 0) continue
    if (kind === 'duplicates') {
      out.push(issue(kind, 'review', { keys, groups: [keys] }))
      continue
    }
    const value = row.evidence[0]?.value_en
    const notes = value && keys.length === 1 && (kind === 'small' || kind === 'low_aesthetic') ? { [keys[0] as string]: value } : undefined
    out.push(issue(kind, 'review', { keys, ...(notes ? { notes } : {}) }))
  }
  return out
}

// ---- the audit (every image: sizes on disk, perceptual-hash near duplicates) --------------

export interface AuditItem {
  image_id: number
  abs_path: string
  width: number | null
  height: number | null
  /** Only when the audit was asked to score (folder images have no stored score). */
  aesthetic_score?: number | null
  flags: string[]
}

export interface AuditReport {
  items: AuditItem[]
  duplicate_groups: { image_ids: number[]; abs_paths: string[] }[]
}

export function auditIssues(report: AuditReport, index: KeyIndex): CheckIssue[] {
  const small: string[] = []
  const missing: string[] = []
  const low: string[] = []
  const notes: Record<string, string> = {}
  const scores: Record<string, string> = {}
  for (const item of report.items) {
    const key = lookup(index, item.image_id, item.abs_path)
    if (!key) continue
    if (item.flags.includes('missing')) missing.push(key)
    if (item.flags.includes('small')) {
      small.push(key)
      if (item.width && item.height) notes[key] = `${item.width}×${item.height}`
    }
    if (item.flags.includes('low_quality')) {
      low.push(key)
      if (typeof item.aesthetic_score === 'number') scores[key] = item.aesthetic_score.toFixed(1)
    }
  }
  const groups = report.duplicate_groups
    .map((g) => [...new Set(g.image_ids.map((id, i) => lookup(index, id, g.abs_paths[i])).filter(present))])
    .filter((g) => g.length > 1)
  return [
    ...(small.length ? [issue('small', 'audit', { keys: small, notes })] : []),
    ...(missing.length ? [issue('file_missing', 'audit', { keys: missing })] : []),
    ...(low.length ? [issue('low_aesthetic', 'audit', { keys: low, notes: scores })] : []),
    ...(groups.length ? [issue('duplicates', 'audit', { keys: groups.flat(), groups })] : []),
  ]
}

// ---- health by purpose (POST /api/tags/consistency/report) ---------------------------------

export interface HealthFinding {
  id: string
  severity: string
  title_en: string
  title_zh: string
  detail_en: string
  detail_zh: string
  fix: { image_ids?: number[] } | null
  data: Record<string, unknown>
}

export interface HealthReport {
  images: number
  findings: HealthFinding[]
}

const idsIn = (value: unknown): number[] => (Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [])

/**
 * The backend's tag-level findings (rare tags, spellings, co-occurrence) read
 * the Library's tags, which a batch's rules and edits change: rare tags and
 * co-occurrence come from the final captions instead (captionChecks.ts), and
 * spellings are one tag there. Rating findings only count when rating tags
 * reach the captions.
 */
const CAPTION_LEVEL = new Set(['low-frequency-tags', 'spelling-variants', 'cooccurring-duplicates'])

function healthIssue(f: HealthFinding, report: HealthReport, index: KeyIndex, ratingsInCaptions: boolean): CheckIssue | null {
  const keysOf = (ids: number[]) => ids.map((id) => lookup(index, id, null)).filter(present)
  switch (f.id) {
    case 'trigger-missing':
      return issue('trigger_missing', 'health')
    case 'trigger-collision':
      return issue('trigger_collision', 'health')
    case 'trigger-coverage':
      return issue('trigger_coverage', 'health', { keys: keysOf(idsIn(f.fix?.image_ids)) })
    case 'rating-duplicates':
      return ratingsInCaptions ? issue('rating_conflict', 'health', { keys: keysOf(idsIn(f.data.image_ids)) }) : null
    case 'rating-missing':
      return ratingsInCaptions ? issue('rating_missing', 'health', { keys: keysOf(idsIn(f.data.image_ids)) }) : null
    case 'composition-fullbody': {
      const dist = (f.data.distribution ?? {}) as Record<string, number>
      return issue('fullbody', 'health', { params: { n: (dist['full body'] ?? 0) + (dist['wide shot'] ?? 0), total: report.images } })
    }
  }
  if (CAPTION_LEVEL.has(f.id)) return null
  return issue('health_other', 'health', {
    id: `health:${f.id}`,
    text: { en: f.title_en, zh: f.title_zh, detailEn: f.detail_en, detailZh: f.detail_zh },
  })
}

export function healthIssues(report: HealthReport, index: KeyIndex, o: { ratingsInCaptions: boolean }): CheckIssue[] {
  return report.findings.map((f) => healthIssue(f, report, index, o.ratingsInCaptions)).filter(present)
}

// ---- character purity (CCIP) -------------------------------------------------------------

export interface PurityResult {
  items: { image_id: number; distance: number; outlier: boolean }[]
}

export function purityIssues(result: PurityResult, index: KeyIndex): CheckIssue[] {
  const notes: Record<string, string> = {}
  const keys: string[] = []
  for (const item of result.items) {
    const key = item.outlier ? lookup(index, item.image_id, null) : null
    if (!key) continue
    keys.push(key)
    notes[key] = item.distance.toFixed(2)
  }
  return keys.length ? [issue('character_outlier', 'purity', { keys, notes })] : []
}

// ---- merging -------------------------------------------------------------------------------

/** Groups that share an image become one (union-find over keys). */
function mergeGroups(groups: readonly string[][]): string[][] {
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    const p = parent.get(k) ?? k
    if (p === k) return k
    const root = find(p)
    parent.set(k, root)
    return root
  }
  for (const g of groups) {
    for (const k of g) if (!parent.has(k)) parent.set(k, k)
    for (const k of g.slice(1)) parent.set(find(k), find(g[0] as string))
  }
  const out = new Map<string, string[]>()
  for (const k of parent.keys()) {
    const root = find(k)
    out.set(root, [...(out.get(root) ?? []), k])
  }
  return [...out.values()]
}

const pairKey = (p: TagPair) => [p.a, p.b].sort().join('\u0000')

function combine(a: CheckIssue, b: CheckIssue): CheckIssue {
  const pairs = new Map([...(a.pairs ?? []), ...(b.pairs ?? [])].map((p) => [pairKey(p), p]))
  return {
    ...a,
    severity: SEVERITY_ORDER.indexOf(b.severity) < SEVERITY_ORDER.indexOf(a.severity) ? b.severity : a.severity,
    keys: [...a.keys, ...b.keys],
    ...(a.groups || b.groups ? { groups: [...(a.groups ?? []), ...(b.groups ?? [])] } : {}),
    ...(a.tags || b.tags ? { tags: [...new Set([...(a.tags ?? []), ...(b.tags ?? [])])] } : {}),
    ...(a.pairs || b.pairs ? { pairs: [...pairs.values()] } : {}),
    ...(a.notes || b.notes ? { notes: { ...b.notes, ...a.notes } } : {}),
    sources: [...new Set([...a.sources, ...b.sources])],
  }
}

/** Keys still in the batch, once each, in batch order. */
function tidy(found: CheckIssue, rank: ReadonlyMap<string, number>): CheckIssue | null {
  const inBatch = (k: string) => rank.has(k)
  const byRank = (x: string, y: string) => (rank.get(x) ?? 0) - (rank.get(y) ?? 0)
  const keys = [...new Set(found.keys.filter(inBatch))].sort(byRank)
  const groups = found.groups
    ? mergeGroups(found.groups.map((g) => g.filter(inBatch)))
        .map((g) => g.sort(byRank))
        .filter((g) => g.length > 1)
        .sort((x, y) => byRank(x[0] as string, y[0] as string))
    : undefined
  const imageKeys = groups ? groups.flat().sort(byRank) : keys
  if (imageKeys.length === 0 && !SET_KINDS.has(found.kind)) return null
  const notes = found.notes ? Object.fromEntries(Object.entries(found.notes).filter(([k]) => inBatch(k))) : undefined
  return { ...found, keys: imageKeys, ...(groups ? { groups } : {}), ...(notes ? { notes } : {}) }
}

/** One issue per id from every source, images once in batch order; high first. */
export function mergeIssues(lists: readonly (readonly CheckIssue[])[], order: readonly string[]): CheckIssue[] {
  const byId = new Map<string, CheckIssue>()
  for (const list of lists) {
    for (const found of list) {
      const known = byId.get(found.id)
      byId.set(found.id, known ? combine(known, found) : found)
    }
  }
  const rank = new Map(order.map((k, i) => [k, i]))
  return [...byId.values()]
    .map((found) => tidy(found, rank))
    .filter(present)
    .sort(
      (x, y) =>
        SEVERITY_ORDER.indexOf(x.severity) - SEVERITY_ORDER.indexOf(y.severity) || KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind),
    )
}
