import { translate, type Lang } from '../../i18n'
import type { Page, SettingsTab, ToolId } from '../../lib/route'
import { percent, SCALE_OPTIONS, type ScaleSetting } from '../../lib/uiScale'
import { SETTINGS_PAGES } from '../settings/tabs'
import { TOOLS } from '../tools/registry'
import { composed, command, type Command } from './commands'
import { HELP_PAGES, helpTopic } from './helpTopics'

// Ctrl K entries for the shell: every tool, every settings tab, the language,
// the interface zoom, and the help of every page. Pure: what they do comes in
// through `ops`, so the list can be tested in both languages.

export interface ShellOps {
  openTool: (tool: ToolId) => void
  openSettings: (tab: SettingsTab) => void
  setLang: (lang: Lang) => void
  setScale: (setting: ScaleSetting) => void
  openHelp: (page: Page) => void
}

export function shellCommands(lang: Lang, ops: ShellOps): Command[] {
  const list: Command[] = []
  for (const tool of TOOLS) {
    const text = (l: Lang) => translate(l, 'tools.palette.open', { tool: translate(l, tool.label) })
    list.push(composed(lang, `tool-${tool.id}`, 'palette.group.tools', text, () => ops.openTool(tool.id)))
  }
  for (const tab of SETTINGS_PAGES) {
    const text = (l: Lang) => translate(l, 'settings.palette.open', { tab: translate(l, tab.label) })
    list.push(composed(lang, `settings-${tab.id}`, 'palette.group.settings', text, () => ops.openSettings(tab.id)))
  }
  list.push(command(lang, 'language', 'palette.group.settings', 'settings.palette.language', () => ops.setLang(lang === 'zh-CN' ? 'en' : 'zh-CN')))
  for (const setting of ['auto', ...SCALE_OPTIONS] as const) {
    const text = (l: Lang) => translate(l, 'settings.palette.scale', { value: setting === 'auto' ? translate(l, 'settings.scale.auto') : percent(setting) })
    list.push(composed(lang, `scale-${setting}`, 'palette.group.settings', text, () => ops.setScale(setting)))
  }
  for (const page of HELP_PAGES) {
    const text = (l: Lang) => translate(l, 'help.palette.page', { page: translate(l, helpTopic(page).name) })
    list.push(composed(lang, `help-${page}`, 'lib.palette.groupHelp', text, () => ops.openHelp(page)))
  }
  return list
}
