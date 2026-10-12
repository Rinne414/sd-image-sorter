// Where the filter panel opens: under its 筛选 button, wherever that button
// is (the library's query bar, Sort › rules, a batch's filter bar), moved left
// or narrowed so it stays on screen. Page px (see lib/uiScale.ts). Pure.

const WIDTH = 720
const MAX_HEIGHT = 620
const GAP = 6
const EDGE = 12

export interface PanelPlace {
  left: number
  top: number
  width: number
  maxHeight: number
}

export function panelPlace(button: { left: number; right: number; bottom: number }, view: { width: number; height: number }): PanelPlace {
  const width = Math.min(WIDTH, view.width - 2 * EDGE)
  const left = Math.max(EDGE, Math.min(button.left, view.width - EDGE - width))
  const top = button.bottom + GAP
  return { left, top, width, maxHeight: Math.min(MAX_HEIGHT, view.height - top - EDGE) }
}
