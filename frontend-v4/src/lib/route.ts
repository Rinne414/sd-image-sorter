// The address is the app's route: #/library, #/batch, #/batch/12, #/home,
// #/sort, #/settings/<tab>, #/tools/<tool>. Pure, so both directions are
// tested; the store reads and writes the address through these two.

export type Page = 'home' | 'library' | 'batch' | 'sort' | 'settings' | 'tools'

/** The pages behind the top-bar tabs and the logo; settings and tools remember one to go back to. */
export type MainPage = 'home' | 'library' | 'batch' | 'sort'

export const SETTINGS_TABS = ['appearance', 'library', 'models', 'ai', 'disk', 'about'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]

export const TOOL_IDS = ['reader', 'reverse', 'promptlab', 'artist', 'lexicon', 'privacy'] as const
export type ToolId = (typeof TOOL_IDS)[number]

export type Route = { page: MainPage; batchId: number | null } | { page: 'settings'; tab: SettingsTab } | { page: 'tools'; tool: ToolId }

const MAIN: readonly string[] = ['home', 'library', 'batch', 'sort']

export function isMainPage(page: Page): page is MainPage {
  return MAIN.includes(page)
}

function isTab(value: string | undefined): value is SettingsTab {
  return (SETTINGS_TABS as readonly string[]).includes(value ?? '')
}

function isTool(value: string | undefined): value is ToolId {
  return (TOOL_IDS as readonly string[]).includes(value ?? '')
}

export function parseRoute(hash: string): Route {
  const [head, rest] = hash.replace(/^#\/?/, '').split('/')
  if (head === 'settings') return { page: 'settings', tab: isTab(rest) ? rest : 'appearance' }
  if (head === 'tools') return { page: 'tools', tool: isTool(rest) ? rest : TOOL_IDS[0] }
  if (head === 'batch' && rest && /^\d+$/.test(rest)) return { page: 'batch', batchId: Number(rest) }
  const page: MainPage = head === 'home' || head === 'batch' || head === 'sort' ? head : 'library'
  return { page, batchId: null }
}

export function routeHash(route: Route): string {
  if (route.page === 'settings') return `#/settings/${route.tab}`
  if (route.page === 'tools') return `#/tools/${route.tool}`
  return route.page === 'batch' && route.batchId !== null ? `#/batch/${route.batchId}` : `#/${route.page}`
}
