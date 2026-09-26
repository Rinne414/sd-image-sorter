import type { Middleware } from 'openapi-fetch'

// The detailed log (Settings › About › Support): while on, every API request
// is written to the browser console (F12) with its status and how long it took.
// Off by default; the choice is kept in this browser.

export const DEBUG_KEY = 'sd-v4-debug'

export function readDebug(raw: string | null): boolean {
  return raw === '1'
}

function stored(): boolean {
  try {
    return readDebug(localStorage.getItem(DEBUG_KEY))
  } catch {
    return false
  }
}

let on = typeof localStorage === 'undefined' ? false : stored()

export function isDebug(): boolean {
  return on
}

export function setDebug(next: boolean): void {
  on = next
  try {
    if (next) localStorage.setItem(DEBUG_KEY, '1')
    else localStorage.removeItem(DEBUG_KEY)
  } catch {
    // storage blocked: on for this session only
  }
}

interface DebugDeps {
  isOn: () => boolean
  log: (...args: unknown[]) => void
  now: () => number
}

const DEFAULTS: DebugDeps = {
  isOn: isDebug,
  log: (...args) => console.info(...args),
  now: () => performance.now(),
}

/** openapi-fetch middleware: writes each request while the detailed log is on. */
export function debugMiddleware(deps: DebugDeps = DEFAULTS): Middleware {
  const started = new Map<string, number>()
  const where = (request: Request) => {
    const url = new URL(request.url)
    return `${request.method} ${url.pathname}${url.search}`
  }
  const took = (id: string) => {
    const start = started.get(id)
    started.delete(id)
    return start === undefined ? '?' : String(Math.round(deps.now() - start))
  }
  return {
    onRequest({ id }) {
      if (deps.isOn()) started.set(id, deps.now())
    },
    onResponse({ id, request, response }) {
      if (started.has(id)) deps.log(`[sd-v4] ${where(request)} → ${response.status} · ${took(id)} ms`)
    },
    onError({ id, request, error }) {
      if (started.has(id)) deps.log(`[sd-v4] ${where(request)} failed · ${took(id)} ms`, error)
    },
  }
}
