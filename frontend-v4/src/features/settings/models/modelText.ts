import { format, useLang, type Params } from '../../../i18n'
import { enModels } from '../../../i18n/en.models'
import { zhCNModels } from '../../../i18n/zh-CN.models'

// The Model Center's words (i18n/*.models.ts) in the language the app is shown
// in. Read through here, so the page does not depend on the pack being spread
// into the main language packs.

export type ModelKey = keyof typeof zhCNModels

const PACKS = { 'zh-CN': zhCNModels, en: enModels } as const

export function isModelKey(key: string): key is ModelKey {
  return key in zhCNModels
}

/** Outside components (toasts, work started from code). */
export function mt(key: ModelKey, params?: Params): string {
  return format(PACKS[useLang.getState().lang][key], params)
}

export function useMT() {
  const lang = useLang((s) => s.lang)
  return (key: ModelKey, params?: Params) => format(PACKS[lang][key], params)
}
