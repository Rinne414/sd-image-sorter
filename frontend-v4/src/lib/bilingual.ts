import type { Lang } from '../i18n'

const SEPARATOR = ' / '
/** A Chinese half has this many Chinese characters at least. */
const MIN_CJK = 3
/** A Chinese half full of terms (Node.js, run.sh) still has one Chinese character per this many letters. */
const LETTERS_PER_CJK = 3

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0

/**
 * Backend sentences arrive as "<English> / <中文>" so either interface can
 * show them. Returns the half for the interface language. Anything else
 * comes back unchanged: an English line that only names a Chinese folder,
 * or a Chinese line that mentions "Linux / macOS", is not split.
 */
export function pickLanguageHalf(text: string, lang: Lang): string {
  const firstCjk = text.search(/[\u3400-\u9fff]/)
  if (firstCjk <= 0) return text
  const cut = text.lastIndexOf(SEPARATOR, firstCjk)
  if (cut <= 0) return text
  const english = text.slice(0, cut).trim()
  const chinese = text.slice(cut + SEPARATOR.length).trim()
  const isEnglish = /[A-Za-z]/.test(english)
  const cjk = count(chinese, /[\u3400-\u9fff]/g)
  const isChinese = cjk >= MIN_CJK && cjk * LETTERS_PER_CJK >= count(chinese, /[A-Za-z]/g)
  if (!isEnglish || !isChinese) return text
  return lang === 'zh-CN' ? chinese : english
}
