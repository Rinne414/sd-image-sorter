import { translate, type Lang, type MessageKey, type Params } from '../../i18n'

// A Ctrl K command, and how the palette finds it: the words of both
// languages are searched, so either one finds any command.

export interface Command {
  id: string
  group: MessageKey
  label: string
  /** Both languages, lower case. */
  haystack: string
  hint?: string
  run: () => void
}

/** A command whose text is built per language (a label with a translated part inside). */
export function composed(lang: Lang, id: string, group: MessageKey, text: (lang: Lang) => string, run: () => void, hint?: string): Command {
  return {
    id,
    group,
    label: text(lang),
    haystack: `${text('zh-CN')} ${text('en')}`.toLowerCase(),
    run,
    ...(hint ? { hint } : {}),
  }
}

/** A command whose text is one message. */
export function command(lang: Lang, id: string, group: MessageKey, key: MessageKey, run: () => void, hint?: string, params?: Params): Command {
  return composed(lang, id, group, (l) => translate(l, key, params), run, hint)
}

/** Every typed word appears in the command's text (in either language). */
export function matches(cmd: Command, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return terms.every((term) => cmd.haystack.includes(term))
}
