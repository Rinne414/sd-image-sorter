import { format, useLang, type Params } from '../../i18n'
import { enReader } from '../../i18n/en.reader'
import { zhCNReader } from '../../i18n/zh-CN.reader'

// The Reader's and Reverse prompt's words (i18n/*.reader.ts), in the language
// the app is shown in. Read through here, so the two tools do not depend on
// the pack being spread into the main language packs.

export type ToolKey = keyof typeof zhCNReader

const PACKS = { 'zh-CN': zhCNReader, en: enReader } as const

/** Outside components (toasts, dialogs started from code). */
export function tt(key: ToolKey, params?: Params): string {
  return format(PACKS[useLang.getState().lang][key], params)
}

export function useTT() {
  const lang = useLang((s) => s.lang)
  return (key: ToolKey, params?: Params) => format(PACKS[lang][key], params)
}
