import type { AxisEnd, AxisName, Region } from './types'

// Where the HTML overlays sit over the canvas: the region landmark cards and
// the six axis-end labels. The scene projects world points; these functions
// turn the projected points into boxes that stay inside the canvas and do not
// sit on each other. Pure, so the placement rules are tested.

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

// ---- landmarks --------------------------------------------------------------

/** A canvas whose short side is under this gets the small cards (six cards must not cover the cloud). */
const SMALL_CANVAS_SHORT_SIDE = 700
export const CARD_SIZES = {
  large: { thumb: 96, pad: 8, gap: 6, textLine: 16 },
  small: { thumb: 64, pad: 6, gap: 4, textLine: 14 },
} as const
export type CardSize = keyof typeof CARD_SIZES
const TEXT_SIDE_ROOM = 16
const FAR_SCALE = 0.72
const FAR_OPACITY = 0.55
export const EDGE_MARGIN = 6
const NUDGE_STEP = 20
const NUDGE_MAX = 80
const DIAGONAL = Math.SQRT1_2
const NUDGE_DIRECTIONS: readonly [number, number][] = [
  [0, -1], [0, 1], [-1, 0], [1, 0],
  [-DIAGONAL, -DIAGONAL], [DIAGONAL, -DIAGONAL], [-DIAGONAL, DIAGONAL], [DIAGONAL, DIAGONAL],
]
export const MAX_LANDMARKS = 12

export function cardSizeFor(width: number, height: number): CardSize {
  return Math.min(width, height) < SMALL_CANVAS_SHORT_SIDE ? 'small' : 'large'
}

/** Full (picture + one line) and compact (picture only) boxes of a size set. */
export function cardBoxes(size: CardSize): { full: { w: number; h: number }; compact: { w: number; h: number } } {
  const m = CARD_SIZES[size]
  const compact = m.thumb + 2 * m.pad
  return { full: { w: compact + TEXT_SIDE_ROOM, h: compact + m.gap + m.textLine }, compact: { w: compact, h: compact } }
}

/** A region centre as the camera sees it. */
export interface Projected {
  x: number
  y: number
  /** 0 at the front of the cloud, 1 at the back. */
  depth: number
  behind: boolean
}

export interface CardPlace {
  hidden: boolean
  x: number
  y: number
  scale: number
  opacity: number
  compact: boolean
}

const HIDDEN: CardPlace = { hidden: true, x: 0, y: 0, scale: 1, opacity: 1, compact: false }

function centred(px: number, py: number, size: { w: number; h: number }, scale: number): Rect {
  const w = size.w * scale
  const h = size.h * scale
  return { x: px - w / 2, y: py - h / 2, w, h }
}

/** The nearest free spot within NUDGE_MAX px, or null. */
function nudge(rect: Rect, free: (r: Rect) => boolean, width: number, height: number): Rect | null {
  const inside = (r: Rect) => r.x >= 0 && r.y >= 0 && r.x + r.w <= width && r.y + r.h <= height
  for (let step = NUDGE_STEP; step <= NUDGE_MAX; step += NUDGE_STEP) {
    for (const [dx, dy] of NUDGE_DIRECTIONS) {
      const candidate = { ...rect, x: rect.x + dx * step, y: rect.y + dy * step }
      if (inside(candidate) && free(candidate)) return candidate
    }
  }
  return null
}

/**
 * Lay the cards out in region order (largest first): a card that would sit on
 * an earlier one keeps its picture only, and one that still collides slides
 * a little; with no free spot near, it stays off rather than on top. Far
 * cards shrink and fade. The open card (`open`, hovered) keeps its full size
 * at its measured box and is shifted inside the canvas.
 */
export function placeCards(
  points: readonly Projected[],
  canvas: { width: number; height: number },
  size: CardSize,
  open: number,
  openBox: { w: number; h: number } | null,
): CardPlace[] {
  const { full, compact } = cardBoxes(size)
  const { width, height } = canvas
  const placed: Rect[] = []
  const free = (r: Rect) => !placed.some((other) => overlaps(r, other))
  return points.map((p, index) => {
    const outside = p.x < -EDGE_MARGIN || p.x > width + EDGE_MARGIN || p.y < -EDGE_MARGIN || p.y > height + EDGE_MARGIN
    if (p.behind || outside) return HIDDEN
    const isOpen = index === open
    const depth = Math.min(1, Math.max(0, p.depth))
    const scale = isOpen ? 1 : 1 - (1 - FAR_SCALE) * depth
    const opacity = isOpen ? 1 : 1 - (1 - FAR_OPACITY) * depth
    let rect: Rect | null = centred(p.x, p.y, full, scale)
    let isCompact = false
    if (isOpen) {
      rect = centred(p.x, p.y, openBox ?? full, 1)
      rect.x = Math.min(Math.max(rect.x, 0), Math.max(0, width - rect.w))
      rect.y = Math.min(Math.max(rect.y, 0), Math.max(0, height - rect.h))
    } else if (!free(rect)) {
      isCompact = true
      rect = centred(p.x, p.y, compact, scale)
      if (!free(rect)) rect = nudge(rect, free, width, height)
    }
    if (!rect) return HIDDEN
    placed.push(rect)
    return { hidden: false, x: rect.x, y: rect.y, scale, opacity, compact: isCompact }
  })
}

/** The words of a closed card: its tags, else its top artist, else nothing. */
export function summaryParts(region: Pick<Region, 'tags' | 'artists'>): { tags: string[]; artist: string | null } {
  const tags = (region.tags ?? []).map((t) => t.tag)
  if (tags.length) return { tags, artist: null }
  const first = region.artists?.[0]
  return { tags: [], artist: first ? first.artist : null }
}

// ---- axis labels ------------------------------------------------------------

export type End = 'low' | 'high'
type V3 = [number, number, number]

export interface AxisAnchors {
  center: V3
  ends: Record<AxisName, Record<End, V3>>
}

/** World anchors of the six labels on the floor grid (the vertical axis stands on its near-left corner). */
export function axisAnchors(core: { min: V3; max: V3 } | null, floorY: number, cloudTopY: number, pad: number): AxisAnchors | null {
  if (!core || !Number.isFinite(floorY)) return null
  const x0 = core.min[0] - pad
  const x1 = core.max[0] + pad
  const z0 = core.min[2] - pad
  const z1 = core.max[2] + pad
  const xm = (x0 + x1) / 2
  const zm = (z0 + z1) / 2
  return {
    center: [xm, (floorY + cloudTopY) / 2, zm],
    ends: {
      x: { low: [x0, floorY, zm], high: [x1, floorY, zm] },
      y: { low: [x0, floorY, z0], high: [x0, cloudTopY, z0] },
      z: { low: [xm, floorY, z0], high: [xm, floorY, z1] },
    },
  }
}

// Screen directions in 45-degree steps, counter-clockwise from "right".
const ARROWS = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'] as const

/** The arrow for a screen-space direction (y grows downward). */
export function arrowFor(dx: number, dy: number): string {
  const turn = Math.round(Math.atan2(-dy, dx) / (Math.PI / 4))
  return ARROWS[((turn % 8) + 8) % 8]!
}

/** A label's strongest tags (at most `limit`), or null when the end has none. */
export function endTags(end: AxisEnd | undefined, limit = 2): string[] | null {
  const tags = (end?.tags ?? []).slice(0, limit).map((t) => t.tag)
  return tags.length ? tags : null
}

const LABEL_GAP = 8
const NUDGE_STEPS = 4

/**
 * Put a label just outside the grid: from its anchor, away from the middle of
 * the cloud, by its own half extent plus a gap; kept inside the canvas and
 * slid up or down until it clears the labels placed before it.
 */
export function placeLabel(
  here: { x: number; y: number },
  centre: { x: number; y: number },
  size: { w: number; h: number },
  canvas: { width: number; height: number },
  placed: readonly Rect[],
): Rect {
  const { w, h } = size
  let dx = here.x - centre.x
  let dy = here.y - centre.y
  const length = Math.hypot(dx, dy) || 1
  dx /= length
  dy /= length
  const reach = Math.min(Math.abs(dx) > 1e-6 ? w / 2 / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? h / 2 / Math.abs(dy) : Infinity)
  const cx = here.x + dx * (reach + LABEL_GAP)
  const cy = here.y + dy * (reach + LABEL_GAP)
  const clamp = (value: number, extent: number, room: number) => Math.min(Math.max(value, EDGE_MARGIN), Math.max(EDGE_MARGIN, room - extent - EDGE_MARGIN))
  const rect = { x: clamp(cx - w / 2, w, canvas.width), y: clamp(cy - h / 2, h, canvas.height), w, h }
  if (!placed.some((other) => overlaps(rect, other))) return rect
  for (let step = 1; step <= NUDGE_STEPS; step += 1) {
    for (const sign of [1, -1]) {
      const y = rect.y + sign * step * (rect.h + 4)
      const next = { ...rect, y }
      if (y >= EDGE_MARGIN && y + rect.h <= canvas.height - EDGE_MARGIN && !placed.some((other) => overlaps(next, other))) return next
    }
  }
  return rect
}
