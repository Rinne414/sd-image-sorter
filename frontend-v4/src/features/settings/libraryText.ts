import { format, useLang, type Params } from '../../i18n'
import { enLibrarySettings } from '../../i18n/en.library-settings'
import { zhCNLibrarySettings } from '../../i18n/zh-CN.library-settings'

// The words of Settings › Library, Settings › Disk & cache and the idle check
// (i18n/*.library-settings.ts), in the language the app is shown in. Read
// through here, so these pages do not depend on the pack being spread into the
// main language packs.

export type LibKey = keyof typeof zhCNLibrarySettings

const PACKS = { 'zh-CN': zhCNLibrarySettings, en: enLibrarySettings } as const

export function isLibKey(key: string): key is LibKey {
  return key in zhCNLibrarySettings
}

/** Outside components (toasts, work started from code). */
export function lt(key: LibKey, params?: Params): string {
  return format(PACKS[useLang.getState().lang][key], params)
}

export function useLT() {
  const lang = useLang((s) => s.lang)
  return (key: LibKey, params?: Params) => format(PACKS[lang][key], params)
}
