// Zooming and panning the big image. The picture is first fitted into the
// stage; a view scales that fitted picture (1 = fitted) and shifts its centre
// from the stage centre by x / y screen pixels. Pure: Lightbox.tsx measures.

export interface Size {
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

export interface View {
  scale: number
  x: number
  y: number
}

export interface Frame {
  /** The visible area. */
  stage: Size
  /** The picture's size when fitted. */
  fitted: Size
  /** The scale at which one picture pixel is one screen pixel. */
  original: number
}

export const FIT: View = { scale: 1, x: 0, y: 0 }

/** How far past its own pixels the picture can be enlarged. */
const MAX_OF_ORIGINAL = 8
/** However small the picture, this much zoom is always available. */
const MIN_ZOOM_ROOM = 4

export const isFit = (v: View) => v.scale === 1 && v.x === 0 && v.y === 0

export function fittedSize(natural: Size, box: Size): Size {
  const k = Math.min(box.w / natural.w, box.h / natural.h)
  return { w: natural.w * k, h: natural.h * k }
}

/** Never smaller than fitted (or than its own pixels, for a picture fitted larger than it is). */
export function limitsFor(frame: Frame): { min: number; max: number } {
  return { min: Math.min(1, frame.original), max: Math.max(MIN_ZOOM_ROOM, frame.original * MAX_OF_ORIGINAL) }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Keep the picture over the stage: it can move only as far as it overhangs; smaller than the stage, it stays centred. */
export function clampPan(view: View, frame: Frame): View {
  const maxX = Math.max(0, (frame.fitted.w * view.scale - frame.stage.w) / 2)
  const maxY = Math.max(0, (frame.fitted.h * view.scale - frame.stage.h) / 2)
  const next = { scale: view.scale, x: clamp(view.x, -maxX, maxX) || 0, y: clamp(view.y, -maxY, maxY) || 0 }
  return next.scale === 1 && next.x === 0 && next.y === 0 ? FIT : next
}

/** Zoom by `factor` around `at` (from the stage centre): the picture point under it stays under it. */
export function zoomAt(view: View, factor: number, at: Point, frame: Frame): View {
  const { min, max } = limitsFor(frame)
  const scale = clamp(view.scale * factor, min, max)
  const k = scale / view.scale
  return clampPan({ scale, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k }, frame)
}

export function panBy(view: View, dx: number, dy: number, frame: Frame): View {
  return clampPan({ scale: view.scale, x: view.x + dx, y: view.y + dy }, frame)
}

/** Click or Z: fitted goes to the picture's own size around `at`; anything else back to fitted. */
export function toggleZoom(view: View, at: Point, frame: Frame): View {
  if (!isFit(view)) return FIT
  return zoomAt(FIT, frame.original, at, frame)
}

/** One wheel step as a zoom factor; line and page steps are turned into pixels first. */
export function wheelFactor(deltaY: number, deltaMode: number): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY
  return Math.exp(-px * 0.0015)
}

/** The view as a share of the picture's own size, in percent. */
export function percentOfOriginal(view: View, frame: Frame): number {
  return Math.round((view.scale / frame.original) * 100)
}
