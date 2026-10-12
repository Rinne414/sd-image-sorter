// Folders recently exported into, newest first, per kind of export (a Pixiv
// set and a training set rarely go to the same place). Kept in this browser.

const RECENT_MAX = 8

export function recentFolders(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string' && p.length > 0) : []
  } catch {
    return []
  }
}

export function rememberFolder(key: string, path: string): void {
  try {
    localStorage.setItem(key, JSON.stringify([path, ...recentFolders(key).filter((p) => p !== path)].slice(0, RECENT_MAX)))
  } catch {
    // storage blocked: the list just won't be remembered
  }
}
