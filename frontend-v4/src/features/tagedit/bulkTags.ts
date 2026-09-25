// Bulk tag edits on the picks: request building and dry-run summaries for
// POST /api/tags/bulk/{add,remove,find-replace,cleanup}. Every op can run as a
// dry run first; an applied op is journaled and can be undone once.

export type BulkOp = 'add' | 'remove' | 'replace' | 'cleanup'

export interface BulkForm {
  op: BulkOp
  /** add / remove: comma separated. */
  tags: string
  find: string
  /** Empty: the found tag is deleted. */
  replace: string
  caseSensitive: boolean
  regex: boolean
  minConfidence: number
  dedupe: boolean
}

export function parseTagList(text: string): string[] {
  const out: string[] = []
  for (const part of text.split(/[,，\n]/)) {
    const tag = part.trim()
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out
}

export type BulkPath = '/api/tags/bulk/add' | '/api/tags/bulk/remove' | '/api/tags/bulk/find-replace' | '/api/tags/bulk/cleanup'

/** The request for `form` over `ids`, or null when there is nothing to do yet. */
export function bulkRequest(form: BulkForm, ids: number[], dryRun: boolean): { path: BulkPath; body: Record<string, unknown> } | null {
  if (ids.length === 0) return null
  const scope = { image_ids: ids }
  switch (form.op) {
    case 'add': {
      const tags = parseTagList(form.tags)
      return tags.length ? { path: '/api/tags/bulk/add', body: { ...scope, tags, dry_run: dryRun } } : null
    }
    case 'remove': {
      const tags = parseTagList(form.tags)
      if (!tags.length) return null
      return { path: '/api/tags/bulk/remove', body: { ...scope, tags, case_sensitive: form.caseSensitive, dry_run: dryRun } }
    }
    case 'replace': {
      const find = form.find.trim()
      if (!find) return null
      return {
        path: '/api/tags/bulk/find-replace',
        body: { ...scope, find, replace: form.replace.trim(), case_sensitive: form.caseSensitive, regex: form.regex, dry_run: dryRun },
      }
    }
    case 'cleanup':
      return { path: '/api/tags/bulk/cleanup', body: { ...scope, min_confidence: form.minConfidence, dedupe: form.dedupe, dry_run: dryRun } }
  }
}

export interface Sample {
  imageId: number
  removed: string[]
  added: string[]
  /** cleanup: how many low-confidence and duplicate tags go. */
  note: { lowConf: number; dupes: number } | null
}

export interface Summary {
  images: number
  tags: number
  samples: Sample[]
}

type Raw = Record<string, unknown>
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const rows = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((r): r is Raw => !!r && typeof r === 'object') : [])

/** What a dry run (or an applied op) says it changes. */
export function summarize(op: BulkOp, result: unknown): Summary {
  const r: Raw = result && typeof result === 'object' ? (result as Raw) : {}
  const tags =
    op === 'replace'
      ? num(r.affected_tags)
      : op === 'add'
        ? num(r.total_tags_added)
        : op === 'remove'
          ? num(r.total_tags_removed)
          : num(r.total_low_conf_removed) + num(r.total_duplicates_removed)
  const samples = rows(r.sample_changes).map((s): Sample => {
    const imageId = num(s.image_id)
    if (op === 'replace') {
      const before = strs(s.before)
      const after = strs(s.after)
      return { imageId, removed: before.filter((t) => !after.includes(t)), added: after.filter((t) => !before.includes(t)), note: null }
    }
    if (op === 'cleanup') {
      return { imageId, removed: [], added: [], note: { lowConf: num(s.removed_low_conf), dupes: num(s.removed_dupes) } }
    }
    return { imageId, removed: strs(s.removed), added: strs(s.added), note: null }
  })
  return { images: num(r.affected_images), tags, samples }
}
