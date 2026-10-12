import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { MessageKey } from '../../i18n'
import type { SettingsTab } from '../../lib/route'

// The Settings page's tabs, in order, each with its page (a lazy import).

export interface SettingsTabEntry {
  id: SettingsTab
  label: MessageKey
  page: LazyExoticComponent<ComponentType>
}

export const SETTINGS_PAGES: readonly SettingsTabEntry[] = [
  {
    id: 'appearance',
    label: 'settings.tab.appearance',
    page: lazy(() => import('./AppearanceTab').then((m) => ({ default: m.AppearanceTab }))),
  },
  { id: 'library', label: 'settings.tab.library', page: lazy(() => import('./library/LibraryTab').then((m) => ({ default: m.LibraryTab }))) },
  {
    id: 'models',
    label: 'settings.tab.models',
    page: lazy(() => import('./models/ModelCenterTab').then((m) => ({ default: m.ModelCenterTab }))),
  },
  { id: 'ai', label: 'settings.tab.ai', page: lazy(() => import('./ai/AiTab').then((m) => ({ default: m.AiTab }))) },
  { id: 'disk', label: 'settings.tab.disk', page: lazy(() => import('./disk/DiskTab').then((m) => ({ default: m.DiskTab }))) },
  {
    id: 'about',
    label: 'settings.tab.about',
    page: lazy(() => import('./about/AboutTab').then((m) => ({ default: m.AboutTab }))),
  },
]

export function settingsTab(id: SettingsTab): SettingsTabEntry {
  const tab = SETTINGS_PAGES.find((t) => t.id === id)
  if (!tab) throw new Error(`no settings tab ${id}`)
  return tab
}
