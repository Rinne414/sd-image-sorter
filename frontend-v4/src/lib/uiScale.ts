// Interface zoom for big screens: CSS zoom on <html>, the V3.5 rule. index.html
// applies it before first paint from the same key and thresholds (a test holds
// the two together); features/settings/uiScaleStore.ts changes it afterwards.
//
// Under zoom, pointer coordinates (clientX) and element boxes
// (getBoundingClientRect) are in screen px, while CSS lengths, offsetWidth
// and scroll offsets are in the page's own px. Code that turns a pointer
// position into a CSS position or a canvas point divides by the zoom:
// pointIn / toPagePx below.

export const UI_SCALE_KEY = 'sd-v4-ui-scale'

export const SCALE_OPTIONS = [1, 1.15, 1.3, 1.4, 1.5] as const
export type Scale = (typeof SCALE_OPTIONS)[number]
export type ScaleSetting = 'auto' | Scale

/** The narrowest page the layout is built for, in the page's own px. */
export const MIN_LAYOUT_WIDTH = 1280

/** Auto: bigger windows get a bigger interface (the window width does not change with the zoom). */
export function autoScale(windowWidth: number): Scale {
  if (windowWidth >= 3600) return 1.5
  if (windowWidth >= 3100) return 1.4
  if (windowWidth >= 2350) return 1.3
  if (windowWidth >= 2000) return 1.15
  return 1
}

export function parseScaleSetting(raw: string | null): ScaleSetting {
  const n = Number(raw)
  return raw !== null && raw.trim() !== '' && (SCALE_OPTIONS as readonly number[]).includes(n) ? (n as Scale) : 'auto'
}

export function scaleFor(setting: ScaleSetting, windowWidth: number): Scale {
  return setting === 'auto' ? autoScale(windowWidth) : setting
}

/** A zoom as people read it: 1.15 is "115%". */
export const percent = (scale: number): string => `${Math.round(scale * 100)}%`

/** How wide the page is at this zoom, in its own px, and whether the layout still fits. */
export function roomAt(windowWidth: number, scale: number): { width: number; fits: boolean } {
  const width = Math.round(windowWidth / scale)
  return { width, fits: width >= MIN_LAYOUT_WIDTH }
}

/** The zoom in effect now (1 outside a browser). */
export function uiZoom(): number {
  if (typeof document === 'undefined') return 1
  const z = parseFloat(document.documentElement.style.zoom)
  return z > 0 ? z : 1
}

/** A distance in screen px (a pointer delta) as page px. */
export function toPagePx(screenPx: number): number {
  return screenPx / uiZoom()
}

/** Where the pointer is inside `el`, in page px from its top-left corner. */
export function pointIn(el: Element, e: { clientX: number; clientY: number }): [number, number] {
  const box = el.getBoundingClientRect()
  const z = uiZoom()
  return [(e.clientX - box.left) / z, (e.clientY - box.top) / z]
}
