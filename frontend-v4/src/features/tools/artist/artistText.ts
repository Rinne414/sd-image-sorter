import { format, useLang, type Params } from '../../../i18n'
import { enArtist } from '../../../i18n/en.artist'
import { zhCNArtist } from '../../../i18n/zh-CN.artist'

// 画风识别's words (i18n/*.artist.ts), in the language the app is shown in.
// Read through here, so the tool does not depend on the pack being spread into
// the main language packs.

export type ArtistKey = keyof typeof zhCNArtist

const PACKS = { 'zh-CN': zhCNArtist, en: enArtist } as const

/** Outside components (toasts, the job's reader). */
export function art(key: ArtistKey, params?: Params): string {
  return format(PACKS[useLang.getState().lang][key], params)
}

export function useAT() {
  const lang = useLang((s) => s.lang)
  return (key: ArtistKey, params?: Params) => format(PACKS[lang][key], params)
}
