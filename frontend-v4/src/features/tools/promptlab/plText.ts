import { format, useLang, type Params } from '../../../i18n'
import { enPromptLab } from '../../../i18n/en.promptlab'
import { zhCNPromptLab } from '../../../i18n/zh-CN.promptlab'

// 提示词助手's words (i18n/*.promptlab.ts), in the language the app is shown
// in. Read through here, so the tool does not depend on the pack being spread
// into the main language packs.

export type PlKey = keyof typeof zhCNPromptLab

const PACKS = { 'zh-CN': zhCNPromptLab, en: enPromptLab } as const

/** Outside components (toasts, actions started from code). */
export function plt(key: PlKey, params?: Params): string {
  return format(PACKS[useLang.getState().lang][key], params)
}

export function usePL() {
  const lang = useLang((s) => s.lang)
  return (key: PlKey, params?: Params) => format(PACKS[lang][key], params)
}
