import { create } from 'zustand'
import { en } from './en'
import { singularize } from './plural'
import { zhCN, type MessageKey } from './zh-CN'

export type Lang = 'zh-CN' | 'en'

// Shared with V3.5 so both apps speak the same language.
const LANG_KEY = 'sd-image-sorter-lang'

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY)
    if (saved === 'zh-CN' || saved === 'en') return saved
  } catch {
    // storage blocked
  }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

const PACKS: Record<Lang, Record<MessageKey, string>> = { 'zh-CN': zhCN, en }

export const useLang = create<{ lang: Lang; setLang: (lang: Lang) => void }>((set) => ({
  lang: initialLang(),
  setLang: (lang) => {
    try {
      localStorage.setItem(LANG_KEY, lang)
    } catch {
      // storage blocked
    }
    document.documentElement.lang = lang
    set({ lang })
  },
}))

export type Params = Record<string, string | number>

export function format(template: string, params?: Params): string {
  if (!params) return template
  // English: a count of 1 is followed by singular words ("1 image is"), see plural.ts.
  return singularize(template, params).replace(/\{(\w+)\}/g, (m, key: string) => {
    const v = params[key]
    if (v === undefined) return m
    return typeof v === 'number' ? v.toLocaleString() : v
  })
}

export function translate(lang: Lang, key: MessageKey, params?: Params): string {
  return format(PACKS[lang][key], params)
}

/** Hook: returns t() bound to the current language; re-renders on switch. */
export function useT() {
  const lang = useLang((s) => s.lang)
  return (key: MessageKey, params?: Params) => translate(lang, key, params)
}

export type { MessageKey }
