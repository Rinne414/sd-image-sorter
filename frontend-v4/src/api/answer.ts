// An answer whose fields the caller reads is checked first: an empty body (a
// 204), `{}` or an answer cut off would otherwise fail later as a script error
// ("Cannot read properties of undefined") shown to the user as the reason.

/** `raw` when it is an object that `has` accepts; otherwise an Error with `reason`. */
export function checkAnswer<T>(raw: unknown, has: (answer: Record<string, unknown>) => boolean, reason: string): T {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !has(raw as Record<string, unknown>)) throw new Error(reason)
  return raw as T
}
