import { translate, useLang } from '../../i18n'
import { useToasts } from '../../ui/toasts'
import { fetchExtensionState, type ExtensionState } from './collectApi'
import { errorKeyFor, nextRequest } from './collectLogic'
import { useCollect } from './collectState'

// Watching the program's side of the browser extension: a pairing request opens
// the prompt (a web page cannot answer it; only this page can), and when
// collected pictures finish indexing the library lists refresh. The poll also
// tells the program which library this page shows, so the extension's pictures
// land in it.

const VISIBLE_MS = 3000
const HIDDEN_MS = 15000
const SOON_MS = 1200

let timer: number | null = null
let generation: number | null = null
let running = false
let onChanged: () => void = () => undefined

function schedule(delay?: number): void {
  if (!running) return
  if (timer !== null) window.clearTimeout(timer)
  timer = window.setTimeout(() => void poll(), delay ?? (document.hidden ? HIDDEN_MS : VISIBLE_MS))
}

/** Look again soon (after the user saved a picture). */
export function pokeCollectWatch(): void {
  schedule(SOON_MS)
}

function reportError(collect: ExtensionState['collect']): void {
  if (!collect.last_error) return
  const key = errorKeyFor(collect.last_error_code)
  const lang = useLang.getState().lang
  useToasts.getState().push(key ? translate(lang, key, collect.last_error_params) : collect.last_error, 'error')
}

function apply(state: ExtensionState): void {
  const request = nextRequest(state.pending ?? [], useCollect.getState().dismissed)
  if (request) useCollect.getState().showPairing(request)
  const next = Number(state.collect?.generation ?? 0)
  const changed = generation !== null && next !== generation
  generation = next
  if (!changed) return
  reportError(state.collect)
  onChanged()
}

async function poll(): Promise<void> {
  try {
    apply(await fetchExtensionState())
  } catch {
    // the program is busy or restarting: the next look tries again
  }
  schedule()
}

/** Start watching; `refresh` runs when collected pictures reach the library. Returns the stop function. */
export function startCollectWatch(refresh: () => void): () => void {
  running = true
  onChanged = refresh
  generation = null
  const wake = () => {
    if (!document.hidden) schedule(0)
  }
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('focus', wake)
  schedule(0)
  return () => {
    running = false
    if (timer !== null) window.clearTimeout(timer)
    timer = null
    document.removeEventListener('visibilitychange', wake)
    window.removeEventListener('focus', wake)
  }
}
