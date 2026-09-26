import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { MessageKey } from '../../i18n'
import type { SettingsTab } from '../../lib/route'

// The Settings page's tabs, in order. A tab built in V4 has its page (a lazy
// import); the others say in one line what will be there and to use V3.5 for
// now. A later slice fills its tab by adding `page` to its own line.

export interface SettingsTabEntry {
  id: SettingsTab
  label: MessageKey
  /** One line: what the tab holds. */
  what: MessageKey
  page?: LazyExoticComponent<ComponentType>
}

export const SETTINGS_PAGES: readonly SettingsTabEntry[] = [
  {
    id: 'appearance',
    label: 'settings.tab.appearance',
    what: 'settings.what.appearance',
    page: lazy(() => import('./AppearanceTab').then((m) => ({ default: m.AppearanceTab }))),
  },
  { id: 'library', label: 'settings.tab.library', what: 'settings.what.library', page: lazy(() => import('./library/LibraryTab').then((m) => ({ default: m.LibraryTab }))) },
  {
    id: 'models',
    label: 'settings.tab.models',
    what: 'settings.what.models',
    page: lazy(() => import('./models/ModelCenterTab').then((m) => ({ default: m.ModelCenterTab }))),
  },
  { id: 'ai', label: 'settings.tab.ai', what: 'settings.what.ai', page: lazy(() => import('./ai/AiTab').then((m) => ({ default: m.AiTab }))) },
  { id: 'disk', label: 'settings.tab.disk', what: 'settings.what.disk', page: lazy(() => import('./disk/DiskTab').then((m) => ({ default: m.DiskTab }))) },
  {
    id: 'about',
    label: 'settings.tab.about',
    what: 'settings.what.about',
    page: lazy(() => import('./about/AboutTab').then((m) => ({ default: m.AboutTab }))),
  },
]

export function settingsTab(id: SettingsTab): SettingsTabEntry {
  const tab = SETTINGS_PAGES.find((t) => t.id === id)
  if (!tab) throw new Error(`no settings tab ${id}`)
  return tab
}
