import type { MessageKey } from '../i18n'
import type { Page, ToolId } from '../lib/route'
import { TOOLS } from '../features/tools/registry'
import type { NavDef } from '../features/navcustom/navChoice'
import { createNavStore } from '../features/navcustom/navStore'

// The places Customize top bar can put in V Opus's bar: the three pages and the
// Reader (Home is the logo; the other tools are in the Tools menu). Hidden ones stay under More, in the Tools
// menu (tools) and in Ctrl K.

export const TOPBAR_NAV_KEY = 'sd-v4-nav-places'

/** The tools that can sit in the bar as tabs; the Tools menu lists all of them. */
const BAR_TOOLS: readonly ToolId[] = ['reader']

export interface TopBarPlace extends NavDef {
  label: MessageKey
  /** The page it opens; tools open the tools page on `tool`. */
  page: Page
  tool?: ToolId
}

export const TOPBAR_PLACES: readonly TopBarPlace[] = [
  { id: 'library', label: 'nav.library', page: 'library' },
  { id: 'batch', label: 'nav.batch', page: 'batch' },
  { id: 'sort', label: 'nav.sort', page: 'sort' },
  ...TOOLS.filter((tool) => BAR_TOOLS.includes(tool.id)).map((tool): TopBarPlace => ({ id: `tool-${tool.id}`, label: tool.label, page: 'tools', tool: tool.id, shown: false })),
]

export const useTopBarNav = createNavStore(TOPBAR_NAV_KEY, TOPBAR_PLACES)

export function placeIsCurrent(place: TopBarPlace, page: Page, toolId: ToolId): boolean {
  return place.tool ? page === 'tools' && toolId === place.tool : page === place.page
}
