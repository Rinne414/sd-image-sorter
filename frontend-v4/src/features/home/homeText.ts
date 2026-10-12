import { format, useLang, type Params } from '../../i18n'
import { enHome } from '../../i18n/en.home'
import { zhCNHome } from '../../i18n/zh-CN.home'

// The home film strip's words (i18n/*.home.ts), in the language the app is
// shown in. Read through here, as the artist tool does, so the strip does not
// depend on the pack being spread into the main language packs.

export type HomeKey = keyof typeof zhCNHome

const PACKS = { 'zh-CN': zhCNHome, en: enHome } as const

export function useHT() {
  const lang = useLang((s) => s.lang)
  return (key: HomeKey, params?: Params) => format(PACKS[lang][key], params)
}
