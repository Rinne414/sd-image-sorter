import type { ArtistKey } from './artistText'
import type { BatchResult, Tier } from './types'

// Pure: what a finished style run says, and how names and confidences read.

type Say = (key: ArtistKey, params?: Record<string, string | number>) => string

const TIERS: ReadonlySet<string> = new Set(['high', 'low', 'none'])

/** "undefined" is the backend's no-name word, never an artist. */
export const isNoName = (name: string | null | undefined) => !name || name.trim().toLowerCase() === 'undefined'

/** A name as people read it (underscores as spaces); the no-name word reads as nothing. */
export function artistName(name: string | null | undefined): string {
  return isNoName(name) ? '' : (name ?? '').trim().replace(/_/g, ' ')
}

/** 0.784 -> "78%"; under 1% keeps a decimal so it does not read as zero. */
export function percent(confidence: number): string {
  const value = confidence * 100
  return `${value < 1 ? Math.round(value * 10) / 10 : Math.round(value)}%`
}

/** The backend's tier; older results without one count as confident only with a real name. */
export function tierOf(result: BatchResult): Tier {
  const level = (result.confidence_level ?? '').toLowerCase()
  if (TIERS.has(level)) return level as Tier
  return isNoName(result.artist) ? 'none' : 'high'
}

function one(result: BatchResult, say: Say): string {
  const tier = tierOf(result)
  const pct = percent(result.confidence)
  if (tier === 'high') return say('artist.job.one.high', { name: artistName(result.artist), pct })
  const candidate = artistName(result.candidate_artist) || artistName(result.artist)
  if (tier === 'low' && candidate) return say('artist.job.one.low', { name: candidate, pct })
  return say('artist.job.one.none')
}

/** The toast at the end of a run: `errors` images failed besides the results. */
export function summarize(results: readonly BatchResult[], errors: number, say: Say): { text: string; tone: 'info' | 'error' } {
  const tone = errors > 0 ? 'error' : 'info'
  if (results.length === 0) return errors > 0 ? { text: say('artist.job.allFailed', { n: errors }), tone: 'error' } : { text: say('artist.job.empty'), tone }
  const failed = errors > 0 ? say('artist.job.failedSuffix', { n: errors }) : ''
  const [only] = results
  if (results.length === 1 && only && errors === 0) return { text: one(only, say), tone }
  const count = { high: 0, low: 0, none: 0 }
  for (const r of results) count[tierOf(r)]++
  const n = results.length
  const text = count.high === 0 ? say('artist.job.noneConfident', { n }) : say('artist.job.many', { n, ...count })
  return { text: text + failed, tone }
}
