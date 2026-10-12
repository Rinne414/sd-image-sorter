// Why saving a censored copy failed, and whether trying again the same way
// can help. Too large or refused data will fail the same way every time, so
// the editor stops retrying on its own and offers "retry" instead.

export type SaveFailure = 'tooLarge' | 'invalid' | 'network' | 'server'

export function failureKind(error: unknown): SaveFailure {
  const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : null
  if (status === 413) return 'tooLarge'
  if (status === 400 || status === 422) return 'invalid'
  // fetch rejects with a TypeError when the request never got an answer
  if (status === null && error instanceof TypeError) return 'network'
  return 'server'
}

export const isFinal = (kind: SaveFailure) => kind === 'tooLarge' || kind === 'invalid'
