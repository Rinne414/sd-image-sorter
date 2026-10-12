import type { ImageDetailResponse } from '../../api/types'
import type { MessageKey } from '../../i18n'
import { readGeneration, shortModelName } from '../../lib/meta'
import { segmentPrompt, tagKey } from '../../lib/prompt'

// "Compare these two": what differs between two images, parameter by
// parameter, and which tags (prompt tags and the image's own tags) only one
// of them has. Pure, so the rules are tested.

export interface DiffRow {
  key: string
  label: MessageKey
  a: string
  b: string
  same: boolean
}

export interface TagDiff {
  onlyA: string[]
  onlyB: string[]
  shared: number
}

export interface Comparison {
  rows: DiffRow[]
  promptTags: TagDiff
  tags: TagDiff
}

function tagSet(values: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const v of values) {
    const key = tagKey(v)
    if (key && !out.has(key)) out.set(key, v.trim())
  }
  return out
}

export function diffTags(a: readonly string[], b: readonly string[]): TagDiff {
  const sa = tagSet(a)
  const sb = tagSet(b)
  const onlyA = [...sa].filter(([k]) => !sb.has(k)).map(([, v]) => v)
  const onlyB = [...sb].filter(([k]) => !sa.has(k)).map(([, v]) => v)
  return { onlyA, onlyB, shared: [...sa.keys()].filter((k) => sb.has(k)).length }
}

const promptTags = (prompt: string | null) =>
  segmentPrompt(prompt ?? '').flatMap((s) => (s.kind === 'tag' ? [s.text] : []))

const ownTags = (d: ImageDetailResponse) => d.tags.filter((t) => t.category !== 'rating').map((t) => t.tag)

type Row = [key: string, label: MessageKey, value: (d: ImageDetailResponse) => string]

const g = (d: ImageDetailResponse) => readGeneration(d.image)

const ROWS: Row[] = [
  ['generator', 'sim.cmp.generator', (d) => d.image.generator ?? ''],
  ['size', 'sim.cmp.size', (d) => g(d).size ?? ''],
  ['model', 'sim.cmp.model', (d) => shortModelName(g(d).model ?? '')],
  ['loras', 'sim.cmp.loras', (d) => g(d).loras.map(shortModelName).join(', ')],
  ['seed', 'sim.cmp.seed', (d) => g(d).seed ?? ''],
  ['steps', 'sim.cmp.steps', (d) => g(d).steps ?? ''],
  ['cfg', 'sim.cmp.cfg', (d) => g(d).cfg ?? ''],
  ['sampler', 'sim.cmp.sampler', (d) => g(d).sampler ?? ''],
  ['scheduler', 'sim.cmp.scheduler', (d) => g(d).scheduler ?? ''],
  ['denoise', 'sim.cmp.denoise', (d) => g(d).denoise ?? ''],
  ['negative', 'sim.cmp.negative', (d) => d.image.negative_prompt ?? ''],
]

/** Every parameter either image has, marked same or different; then the tag differences. */
export function compareDetails(a: ImageDetailResponse, b: ImageDetailResponse): Comparison {
  const rows = ROWS.flatMap(([key, label, value]) => {
    const va = value(a)
    const vb = value(b)
    return va || vb ? [{ key, label, a: va, b: vb, same: va === vb }] : []
  })
  return {
    rows,
    promptTags: diffTags(promptTags(a.image.prompt), promptTags(b.image.prompt)),
    tags: diffTags(ownTags(a), ownTags(b)),
  }
}
