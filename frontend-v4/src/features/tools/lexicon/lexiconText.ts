import { format, useLang, type Params } from '../../../i18n'
import { enLexicon } from '../../../i18n/en.lexicon'
import { zhCNLexicon } from '../../../i18n/zh-CN.lexicon'

// 词库's words (i18n/*.lexicon.ts), in the language the app is shown in.
// Read through here, so the tool does not depend on the pack being spread into
// the main language packs.

export type LexKey = keyof typeof zhCNLexicon

const PACKS = { 'zh-CN': zhCNLexicon, en: enLexicon } as const

/** Outside components (toasts). */
export function lt(key: LexKey, params?: Params): string {
  return format(PACKS[useLang.getState().lang][key], params)
}

export function useLT() {
  const lang = useLang((s) => s.lang)
  return (key: LexKey, params?: Params) => format(PACKS[lang][key], params)
}
