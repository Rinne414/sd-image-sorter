import type { MessageKey } from '../i18n'
import type { NavDef } from '../features/navcustom/navChoice'
import { createNavStore } from '../features/navcustom/navStore'

// The places Customize top bar can arrange in /next/'s bar: its tabs and its
// Censor and Similar menus. "More" is the overflow and always stays.

export const NEXT_NAV_KEY = 'sd-next-nav-places'

export interface NextPlaceDef extends NavDef {
  label: MessageKey
}

export const NEXT_PLACES: readonly NextPlaceDef[] = [
  { id: 'library', label: 'next.place.library' },
  { id: 'batch', label: 'next.place.batch' },
  { id: 'sort', label: 'next.place.sort' },
  { id: 'reader', label: 'next.place.reader' },
  { id: 'censor', label: 'next.place.censor' },
  { id: 'similar', label: 'next.place.similar' },
  { id: 'stylemap', label: 'next.place.stylemap' },
]

export const useNextNav = createNavStore(NEXT_NAV_KEY, NEXT_PLACES)
