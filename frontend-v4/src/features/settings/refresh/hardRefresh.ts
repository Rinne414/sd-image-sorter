// Hard refresh of the interface: drop the browser's caches and service
// workers, then load the page again from the server under a new address so
// no cached copy is used. Libraries, the database and every setting stay
// (they live on the server and in localStorage, which this never touches).
// sessionStorage is left alone too: a running dataset export is resumed from it.

/** The address with a fresh `_t` query value, keeping the path and the #/route. */
export function freshAddress(href: string, now: number): string {
  const url = new URL(href)
  url.searchParams.set('_t', String(now))
  return url.toString()
}

export interface RefreshEnv {
  caches?: { keys: () => Promise<string[]>; delete: (key: string) => Promise<boolean> }
  serviceWorker?: { getRegistrations: () => Promise<readonly { unregister: () => Promise<boolean> }[]> }
  href: string
  now: () => number
  replace: (address: string) => void
  reload: () => void
}

/** Clear caches and workers (each step best effort: one that fails never stops the reload), then load the page again. */
export async function hardRefresh(env: RefreshEnv): Promise<void> {
  try {
    if (env.caches) await Promise.all((await env.caches.keys()).map((key) => env.caches?.delete(key)))
  } catch {
    // a browser that refuses cache access still reloads
  }
  try {
    if (env.serviceWorker) await Promise.all((await env.serviceWorker.getRegistrations()).map((r) => r.unregister()))
  } catch {
    // same
  }
  try {
    env.replace(freshAddress(env.href, env.now()))
  } catch {
    env.reload()
  }
}

/** The real browser's pieces. */
export function browserEnv(): RefreshEnv {
  return {
    caches: typeof caches === 'undefined' ? undefined : caches,
    serviceWorker: typeof navigator === 'undefined' ? undefined : navigator.serviceWorker,
    href: window.location.href,
    now: () => Date.now(),
    replace: (address) => window.location.replace(address),
    reload: () => window.location.reload(),
  }
}
