// Path helpers for folders the backend reports. Paths stay in the form the
// backend gave (Windows `D:\a\b` or POSIX `/a/b`); nothing here touches disk.

const isWindows = (p: string) => /^[A-Za-z]:/.test(p) || p.includes('\\')
const sepOf = (p: string) => (isWindows(p) ? '\\' : '/')

/** The folder that holds `path`, or null at a drive or file-system root. */
export function parentFolder(path: string): string | null {
  if (!path) return null
  const sep = sepOf(path)
  const trimmed = path.length > 1 && path.endsWith(sep) && !/^[A-Za-z]:\\$/.test(path) ? path.slice(0, -1) : path
  if (/^[A-Za-z]:\\?$/.test(trimmed) || trimmed === '/') return null
  const cut = trimmed.lastIndexOf(sep)
  if (cut < 0) return null
  const head = trimmed.slice(0, cut)
  if (sep === '\\' && /^[A-Za-z]:$/.test(head)) return `${head}\\`
  return head || sep
}

/** The last name in a path (a folder's own name); a drive or root is returned whole. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

export function joinFolder(base: string, name: string): string {
  const sep = sepOf(base)
  return base.endsWith(sep) ? `${base}${name}` : `${base}${sep}${name}`
}

export type FolderNameProblem = 'empty' | 'chars' | 'dots' | 'trailing' | 'reserved'

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Why a new folder name would be refused by Windows (the strictest target), or null. */
export function folderNameProblem(name: string): FolderNameProblem | null {
  const n = name.trim()
  if (!n) return 'empty'
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(n)) return 'chars'
  if (n === '.' || n === '..') return 'dots'
  if (n.endsWith('.')) return 'trailing'
  if (RESERVED.test(n)) return 'reserved'
  return null
}

/** The end of a long path (whole folder names), since that is where it differs. */
export function tailOfPath(path: string, max: number): string {
  if (path.length <= max) return path
  const sep = sepOf(path)
  const parts = path.split(sep).filter(Boolean)
  let tail = parts.pop() ?? ''
  while (parts.length) {
    const next = `${parts.at(-1)}${sep}${tail}`
    if (next.length + 2 > max) break
    tail = next
    parts.pop()
  }
  return `…${sep}${tail}`
}
