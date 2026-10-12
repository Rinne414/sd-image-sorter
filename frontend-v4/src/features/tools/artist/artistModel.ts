import { isKey, replaceTokens, tokenValue } from '../../../lib/queryEdit'
import type { ModelCard } from '../../tagging/taggers'
import type { ArtistStats } from './types'

// Pure decisions for the style tool: whether Kaloscope must download first,
// the names typed into "is my artist in the vocabulary?", and the search
// text that shows one artist's images.

export type ModelState = 'ready' | 'download' | 'restart'

/** The Model Center's Kaloscope card decides; no card lets the run try and the backend say what is missing. */
export function artistModelState(cards: readonly ModelCard[] | undefined): ModelState {
  const card = cards?.find((c) => c.id === 'artist')
  if (!card) return 'ready'
  if (card.status === 'needs_restart') return 'restart'
  return card.status === 'ready' || card.available === true ? 'ready' : 'download'
}

/** Names separated by commas (either width), 、 or new lines; each once. */
export function parseNames(text: string): string[] {
  const names = text
    .split(/[\n,、，]+/)
    .map((n) => n.trim())
    .filter(Boolean)
  return [...new Set(names)]
}

/** The search text with this artist as its only artist filter (the rest of the search stays). */
export function withArtist(text: string, name: string): string {
  return replaceTokens(text, isKey('artist'), [`artist:${tokenValue(name)}`])
}

export interface ArtistRow {
  name: string
  count: number
  /** Confident artists only. */
  avg: number | null
  peak: number | null
}

const byCount = (a: ArtistRow, b: ArtistRow) => b.count - a.count || a.name.localeCompare(b.name)

/** The confident artists and the unconfirmed candidates, most images first (the no-name word left out). */
export function artistRows(stats: ArtistStats | undefined): { confident: ArtistRow[]; candidates: ArtistRow[] } {
  const detail = stats?.artist_stats ?? {}
  const confident = Object.entries(stats?.artist_counts ?? {}).map(([name, count]) => ({
    name,
    count: Number(count) || 0,
    avg: detail[name]?.avg_confidence ?? null,
    peak: detail[name]?.max_confidence ?? null,
  }))
  const candidates = Object.entries(stats?.low_confidence_artist_counts ?? {})
    .filter(([name]) => name.trim() && name.trim().toLowerCase() !== 'undefined')
    .map(([name, count]) => ({ name, count, avg: null, peak: null }))
  return { confident: confident.sort(byCount), candidates: candidates.sort(byCount) }
}
