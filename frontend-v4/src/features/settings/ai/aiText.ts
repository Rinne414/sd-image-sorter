import { format, useLang, type Params } from '../../../i18n'
import { enAi } from '../../../i18n/en.ai'
import { zhCNAi } from '../../../i18n/zh-CN.ai'

// The words of Settings › AI services, the Ollama download job and the tag
// panel's "also describe" (i18n/*.ai.ts), in the language the app is shown in.
// Read through here, so these do not depend on the pack being spread into the
// main language packs.

export type AiKey = keyof typeof zhCNAi

const PACKS = { 'zh-CN': zhCNAi, en: enAi } as const

export function isAiKey(key: string): key is AiKey {
  return key in zhCNAi
}

/** Outside components (toasts, job readers). */
export function at(key: AiKey, params?: Params): string {
  return format(PACKS[useLang.getState().lang][key], params)
}

export function useAT() {
  const lang = useLang((s) => s.lang)
  return (key: AiKey, params?: Params) => format(PACKS[lang][key], params)
}
