import { create } from 'zustand'

// Where the image sits in the canvas area: scale `z` and the image's top-left
// corner (tx, ty) in viewport pixels. Pure maths plus one small store shared
// by the canvas and the zoom buttons.

export interface View {
  z: number
  tx: number
  ty: number
}

export const ZOOM_MIN = 0.02
export const ZOOM_MAX = 32
export const ZOOM_STEP = 1.25
const FIT_PAD = 16

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))

/** The whole image centred in the viewport (small images are enlarged too). */
export function fitView(vw: number, vh: number, iw: number, ih: number): View {
  if (vw <= 0 || vh <= 0 || iw <= 0 || ih <= 0) return { z: 1, tx: 0, ty: 0 }
  const z = clampZoom(Math.min((vw - 2 * FIT_PAD) / iw, (vh - 2 * FIT_PAD) / ih))
  return { z, tx: (vw - iw * z) / 2, ty: (vh - ih * z) / 2 }
}

/** Zoom by `factor` keeping viewport point (cx, cy) over the same image pixel. */
export function zoomAt(view: View, factor: number, cx: number, cy: number): View {
  const z = clampZoom(view.z * factor)
  const k = z / view.z
  return { z, tx: cx - (cx - view.tx) * k, ty: cy - (cy - view.ty) * k }
}

/** Viewport point to image pixel. */
export function toImage(view: View, vx: number, vy: number): [number, number] {
  return [(vx - view.tx) / view.z, (vy - view.ty) / view.z]
}

interface ViewState extends View {
  /** Viewport and image size, for fitting. */
  vw: number
  vh: number
  iw: number
  ih: number
  /** Follow the viewport size (until the user zooms or pans). */
  fitted: boolean
  /** Space is held with the pointer over the canvas: dragging pans. */
  panKey: boolean
  /** The pointer is over the canvas. */
  hover: boolean
  setViewport: (vw: number, vh: number) => void
  setImage: (iw: number, ih: number) => void
  fit: () => void
  actualSize: () => void
  zoomBy: (factor: number, cx?: number, cy?: number) => void
  panBy: (dx: number, dy: number) => void
  setPanKey: (on: boolean) => void
  setHover: (on: boolean) => void
}

export const useCanvasView = create<ViewState>((set, get) => ({
  z: 1,
  tx: 0,
  ty: 0,
  vw: 0,
  vh: 0,
  iw: 0,
  ih: 0,
  fitted: true,
  panKey: false,
  hover: false,
  setViewport: (vw, vh) => {
    const s = get()
    set(s.fitted ? { vw, vh, ...fitView(vw, vh, s.iw, s.ih) } : { vw, vh })
  },
  setImage: (iw, ih) => {
    const s = get()
    set({ iw, ih, fitted: true, ...fitView(s.vw, s.vh, iw, ih) })
  },
  fit: () => {
    const s = get()
    set({ fitted: true, ...fitView(s.vw, s.vh, s.iw, s.ih) })
  },
  actualSize: () => {
    const s = get()
    set({ fitted: false, z: 1, tx: (s.vw - s.iw) / 2, ty: (s.vh - s.ih) / 2 })
  },
  zoomBy: (factor, cx, cy) => {
    const s = get()
    set({ fitted: false, ...zoomAt(s, factor, cx ?? s.vw / 2, cy ?? s.vh / 2) })
  },
  panBy: (dx, dy) => {
    const s = get()
    set({ fitted: false, tx: s.tx + dx, ty: s.ty + dy })
  },
  setPanKey: (panKey) => set({ panKey }),
  setHover: (hover) => set({ hover }),
}))
