// The classic interface opens one of its pages from an address
// (/?ui=classic&view=stylemap, frontend/js/entry-page.js). The new interface
// reaches the pages it does not have yet this way.

export type ClassicView = 'censor' | 'similar' | 'stylemap' | 'dataset'

export function classicUrl(view?: ClassicView): string {
  return view ? `/?ui=classic&view=${view}` : '/?ui=classic'
}

export function openClassic(view?: ClassicView): void {
  location.assign(classicUrl(view))
}
