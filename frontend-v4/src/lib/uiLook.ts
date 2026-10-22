// Which interface is drawing: Vopus (index.html) or the new one at /next/
// (next.html sets <html data-ui="next">, docs/DESIGN.md §redesign-2026-10).
// Shared components that draw differently in the new interface ask here, so
// Vopus keeps its look.

export function isNextUi(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.ui === 'next'
}
