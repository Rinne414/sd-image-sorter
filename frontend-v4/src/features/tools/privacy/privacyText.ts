import { format, useLang, type Params } from '../../../i18n'
import { enPrivacy } from '../../../i18n/en.privacy'
import { zhCNPrivacy } from '../../../i18n/zh-CN.privacy'

// 隐私混淆's words (i18n/*.privacy.ts), in the language the app is shown in.
// Read through here, so the tool does not depend on the pack being spread into
// the main language packs.

export type PrivacyKey = keyof typeof zhCNPrivacy

const PACKS = { 'zh-CN': zhCNPrivacy, en: enPrivacy } as const

/** Outside components (toasts, the run). */
export function pt(key: PrivacyKey, params?: Params): string {
  return format(PACKS[useLang.getState().lang][key], params)
}

export function usePT() {
  const lang = useLang((s) => s.lang)
  return (key: PrivacyKey, params?: Params) => format(PACKS[lang][key], params)
}
