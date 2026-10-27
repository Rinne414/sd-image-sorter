import { ApiError } from '../../../../api/client'
import { translate, useLang, type MessageKey, type Params } from '../../../../i18n'
import { problemWords, reasonWords } from './disguiseModel'

// The disguise's words, outside components (toasts, run summaries) and as the
// plain sentences for a reason or an error.

/** A message in the language the page is shown in. */
export function dt(key: MessageKey, params?: Params): string {
  return translate(useLang.getState().lang, key, params)
}

/** Why a picture needs another cover, in words. */
export function reasonText(reason: string): string {
  const { key, params } = reasonWords(reason)
  return dt(key, params)
}

/** An error from the program (or the network), in words. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const { key, params } = problemWords(error.status, error.message)
    return dt(key, params)
  }
  const detail = String((error as Error)?.message ?? error)
  const { key, params } = problemWords(undefined, detail)
  return dt(key, params)
}

/** The same for a stored problem (status and detail). */
export function problemText(status: number | undefined, detail: string): string {
  const { key, params } = problemWords(status, detail)
  return dt(key, params)
}
