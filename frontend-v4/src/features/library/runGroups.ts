import type { ImageSummary } from '../../api/types'

/**
 * "Group runs": pictures from one generation run shown as one stack.
 *
 * A run is pictures next to each other in date order with the same run key
 * (the server's hash of prompt, negative prompt, checkpoint and size), each
 * made within RUN_GAP_MS of the previous one. The grid shows display items;
 * the flat list of pictures never changes, so the lightbox, picks and every
 * batch action keep working on pictures.
 */

/** Two pictures further apart than this start a new run. */
export const RUN_GAP_MS = 10 * 60 * 1000

export interface RunStack {
  /** Stays the same while the run's first picture does: what "open" remembers. */
  key: string
  ids: number[]
  size: number
}

export interface RunMember {
  key: string
  /** 0-based place in the run. */
  position: number
  size: number
}

export interface DisplayItem {
  /** The picture itself (not a copy): a new rating shows at once. */
  img: ImageSummary
  /** Its place in the flat list. */
  flatIndex: number
  /** A closed run: this tile stands for every picture in it. */
  stack?: RunStack
  /** A picture of an open run. */
  member?: RunMember
}

/** Milliseconds; the listing gives Unix seconds (a number or digits) or an ISO date. */
function timeOf(img: ImageSummary): number | null {
  const value = img.library_order_time || img.created_at
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value * 1000 : null
  const text = value.trim()
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000
  const time = Date.parse(text.replace(' ', 'T'))
  return Number.isFinite(time) ? time : null
}

function sameRun(previous: ImageSummary, img: ImageSummary): boolean {
  if (!img.run_key || img.run_key !== previous.run_key) return false
  const a = timeOf(previous)
  const b = timeOf(img)
  return a === null || b === null || Math.abs(a - b) <= RUN_GAP_MS
}

/** Runs as [start, end) pairs over the flat list; single pictures are runs of one. */
export function findRuns(images: readonly ImageSummary[]): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  let start = 0
  for (let index = 1; index <= images.length; index += 1) {
    if (index === images.length || !sameRun(images[index - 1]!, images[index]!)) {
      runs.push([start, index])
      start = index
    }
  }
  return runs
}

/** One display item per picture: the grid without grouping. */
export function flatItems(images: readonly ImageSummary[]): DisplayItem[] {
  return images.map((img, flatIndex) => ({ img, flatIndex }))
}

/** The grid with runs: a closed run is one stack item, an open run shows every picture. */
export function groupRuns(images: readonly ImageSummary[], openKeys: ReadonlySet<string>): DisplayItem[] {
  const items: DisplayItem[] = []
  for (const [start, end] of findRuns(images)) {
    const size = end - start
    const first = images[start]!
    if (size === 1) {
      items.push({ img: first, flatIndex: start })
      continue
    }
    const key = `${first.run_key}:${first.id}`
    if (!openKeys.has(key)) {
      items.push({ img: first, flatIndex: start, stack: { key, ids: images.slice(start, end).map((img) => img.id), size } })
      continue
    }
    for (let index = start; index < end; index += 1) {
      items.push({ img: images[index]!, flatIndex: index, member: { key, position: index - start, size } })
    }
  }
  return items
}

/** The display item showing this picture (a closed stack shows all of its pictures); -1 when none. */
export function displayIndexOf(items: readonly DisplayItem[], id: number | null): number {
  if (id === null) return -1
  return items.findIndex((item) => item.img.id === id || (item.stack?.ids.includes(id) ?? false))
}

/** A range of places in the flat list, widened so it holds every closed stack it touches whole. */
export function widenToStacks(items: readonly DisplayItem[], lo: number, hi: number): [number, number] {
  let from = lo
  let to = hi
  for (const item of items) {
    if (!item.stack) continue
    const start = item.flatIndex
    const end = start + item.stack.size - 1
    if (start <= hi && end >= lo) {
      from = Math.min(from, start)
      to = Math.max(to, end)
    }
  }
  return [from, to]
}

/**
 * The pick label of a tile: its pick order, or for a stack the orders of all
 * its pictures as ranges ("2–5", "1, 4–6"; past two ranges the rest is
 * elided). Empty when the tile is not picked; a stack counts as picked only
 * when every picture of it is.
 */
export function pickLabel(ids: readonly number[], order: ReadonlyMap<number, number>): string {
  const positions = ids.map((id) => order.get(id)).filter((n): n is number => n !== undefined)
  if (!positions.length || positions.length !== ids.length) return ''
  positions.sort((a, b) => a - b)
  const ranges: Array<[number, number]> = []
  for (const position of positions) {
    const last = ranges.at(-1)
    if (last && position === last[1] + 1) last[1] = position
    else ranges.push([position, position])
  }
  const text = ranges.slice(0, 2).map(([from, to]) => (from === to ? String(from) : `${from}–${to}`))
  return ranges.length > 2 ? `${text.join(', ')}…` : text.join(', ')
}
