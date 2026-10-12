// A prompt shown in another tool's weight syntax: SD / A1111 writes
// (tag:1.2) and <lora:name:0.8>, NovelAI writes 1.2::tag:: and {tag} / [tag].
// Ported from V3.5's gallery/prompt-convert.js so both apps convert alike.

export type PromptFormat = 'original' | 'sd' | 'nai'

export type SourceFormat = 'sd' | 'nai' | 'unknown'

/** Which syntax a prompt is written in, from its generator first and its text second. */
export function detectFormat(o: { generator: string | null; text: string; hasCharacters?: boolean; hasNodes?: boolean }): SourceFormat {
  const generator = (o.generator ?? '').toLowerCase()
  if (generator.includes('novel') || generator.includes('nai')) return 'nai'
  if (generator.includes('webui') || generator.includes('forge') || generator.includes('comfy')) return 'sd'
  if (o.hasCharacters) return 'nai'
  if (o.hasNodes) return 'sd'
  if (/\b\d*\.?\d+\s*::/.test(o.text)) return 'nai'
  if (/[{][^{}]+[}]|\[[^[\]]+\]/.test(o.text)) return 'nai'
  if (/<lora:[^>]+>/i.test(o.text)) return 'sd'
  if (/\((?:[^()\\]|\\.)+:\s*-?\d*\.?\d+\)/.test(o.text)) return 'sd'
  return 'unknown'
}

/** A weight with at most three decimals and no trailing zeros ('' when it is not a number). */
export function formatWeight(weight: number | string): string {
  const n = Number(weight)
  if (!Number.isFinite(n)) return ''
  return (Math.round(n * 1000) / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Replace balanced runs like ((x)) or {{x}}: each bracket level multiplies the weight. */
function bracketRuns(text: string, open: string, close: string, step: number, to: (content: string, weight: number, whole: string) => string): string {
  const o = escapeRe(open)
  const c = escapeRe(close)
  const re = new RegExp(`(${o}+)([^${o}${c}]+?)(${c}+)`, 'g')
  return text.replace(re, (whole: string, openRun: string, content: string, closeRun: string) => {
    const inner = content.trim()
    if (!inner || openRun.length !== closeRun.length) return whole
    return to(inner, step ** openRun.length, whole)
  })
}

export function naiToSd(text: string): string {
  if (!text) return ''
  let out = text.replace(/(^|[,\n]\s*|\s)(\d*\.?\d+)::\s*([\s\S]*?)\s*::(?=,|$|\n)/g, (whole: string, pre: string, weight: string, content: string) => {
    const inner = content.trim()
    const w = formatWeight(weight)
    return inner && w ? `${pre}(${inner}:${w})` : whole
  })
  const sd = (content: string, weight: number) => {
    const w = formatWeight(weight)
    return w ? `(${content}:${w})` : content
  }
  out = bracketRuns(out, '{', '}', 1.05, sd)
  out = bracketRuns(out, '[', ']', 1 / 1.05, sd)
  return out.replace(/\s{2,}/g, ' ').trim()
}

export function sdToNai(text: string): string {
  if (!text) return ''
  let out = text.replace(/<lora:([^:>]+):([^>]+)>/gi, (whole: string, name: string, weight: string) => {
    const w = formatWeight(weight)
    const clean = name.trim()
    if (!clean || !w) return clean || whole
    return `${w}::${clean}::`
  })
  out = out.replace(/\(([^()]*?):\s*(-?\d*\.?\d+)\)/g, (whole: string, content: string, weight: string) => {
    const inner = content.trim()
    const w = formatWeight(weight)
    return inner && w ? `${w}::${inner}::` : whole
  })
  const nai = (content: string, weight: number) => {
    const w = formatWeight(weight)
    return w ? `${w}::${content}::` : content
  }
  out = bracketRuns(out, '(', ')', 1.1, (content, weight, whole) => (/:\s*-?\d*\.?\d+\s*$/.test(content) ? whole : nai(content, weight)))
  out = bracketRuns(out, '[', ']', 1 / 1.1, nai)
  return out.replace(/\s{2,}/g, ' ').trim()
}

/** The text in the chosen syntax; unchanged when it already is, or when the source syntax is unknown. */
export function convertPrompt(text: string, source: SourceFormat, target: PromptFormat): string {
  if (!text || target === 'original') return text
  if (target === 'sd' && source === 'nai') return naiToSd(text) || text
  if (target === 'nai' && source === 'sd') return sdToNai(text) || text
  return text
}
