// Split a Stable Diffusion prompt into display segments so the generation card
// can colour tags by category and dim the syntax around them. Understands
// A1111 weights (tag:1.2), bracket emphasis ((tag)) [tag] {tag}, NovelAI V4
// weights 1.2::tag::, <lora:name:0.8>, BREAK / AND, and artist: prefixes.

export type SegmentKind = 'tag' | 'punct' | 'weight' | 'lora' | 'keyword' | 'space' | 'newline'

export interface Segment {
  kind: SegmentKind
  text: string
  /** Normalised lookup key for tags (lowercase, spaces, no artist: prefix). */
  key?: string
  /** Set when the prompt itself says what the tag is (artist:name). */
  forcedCategory?: 'artist'
}

const PATTERNS: [SegmentKind, RegExp][] = [
  ['lora', /<(?:lora|lyco|hypernet):[^>]*>/iy],
  ['weight', /-?\d+(?:\.\d+)?::/y],
  ['punct', /::/y],
  ['weight', /:\s*-?\d+(?:\.\d+)?(?=\s*[)\]}])/y],
  ['newline', /\r?\n/y],
  ['punct', /[(){}[\],|]/y],
]

function matchAt(input: string, pos: number): [SegmentKind, string] | null {
  for (const [kind, re] of PATTERNS) {
    re.lastIndex = pos
    const m = re.exec(input)
    if (m) return [kind, m[0]]
  }
  return null
}

const ARTIST_PREFIX = /^artists?:\s*/i
const KEYWORDS = new Set(['BREAK', 'AND', 'ADDROW', 'ADDCOL', 'ADDCOMM', 'ADDBASE'])

export function tagKey(raw: string): string {
  return raw
    .replace(ARTIST_PREFIX, '')
    .replace(/\\([()[\]{}])/g, '$1')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function pushText(out: Segment[], text: string): void {
  const lead = text.match(/^\s+/)?.[0] ?? ''
  const trail = text.slice(lead.length).match(/\s+$/)?.[0] ?? ''
  const core = text.slice(lead.length, text.length - trail.length)
  if (lead) out.push({ kind: 'space', text: lead })
  if (core) {
    if (KEYWORDS.has(core)) {
      out.push({ kind: 'keyword', text: core })
    } else {
      const seg: Segment = { kind: 'tag', text: core, key: tagKey(core) }
      if (ARTIST_PREFIX.test(core)) seg.forcedCategory = 'artist'
      out.push(seg)
    }
  }
  if (trail) out.push({ kind: 'space', text: trail })
}

export function segmentPrompt(input: string): Segment[] {
  const out: Segment[] = []
  let pos = 0
  let textStart = 0
  while (pos < input.length) {
    const hit = matchAt(input, pos)
    if (!hit) {
      pos += 1
      continue
    }
    if (pos > textStart) pushText(out, input.slice(textStart, pos))
    const [kind, text] = hit
    out.push({ kind, text })
    pos += text.length
    textStart = pos
  }
  if (textStart < input.length) pushText(out, input.slice(textStart))
  return out
}

/** Unique tag keys in a prompt, for one categorize request. */
export function promptTagKeys(segments: Segment[]): string[] {
  const keys = new Set<string>()
  for (const s of segments) if (s.kind === 'tag' && s.key) keys.add(s.key)
  return [...keys]
}
