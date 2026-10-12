import type { FolderNode } from './folderTree'

// Which rows of the library rail's folder tree the user opened or closed by
// hand, per library, so a reload (or coming back to the library) shows the
// same tree. Everything else follows the tree's defaults. Folders that are no
// longer in the library are left out when read back. Pure: FolderTree keeps
// it in localStorage.

export interface OpenState {
  opened: string[]
  closed: string[]
}

export type FolderMemory = Record<string, OpenState>

/** Every folder path of the tree. */
export function folderPaths(tree: readonly FolderNode[]): Set<string> {
  const out = new Set<string>()
  const walk = (nodes: readonly FolderNode[]) => {
    for (const node of nodes) {
      out.add(node.path)
      walk(node.children)
    }
  }
  walk(tree)
  return out
}

/** This library's hand-opened and hand-closed rows, only those still in the tree. */
export function recallOpen(memory: FolderMemory, libraryId: string, existing: ReadonlySet<string>): { opened: Set<string>; closed: Set<string> } {
  const saved = memory[libraryId]
  const keep = (paths: readonly string[] | undefined) => new Set((paths ?? []).filter((p) => existing.has(p)))
  return { opened: keep(saved?.opened), closed: keep(saved?.closed) }
}

/** A new memory with this library's rows; nothing opened or closed by hand forgets the library. */
export function rememberOpen(memory: FolderMemory, libraryId: string, opened: ReadonlySet<string>, closed: ReadonlySet<string>): FolderMemory {
  const { [libraryId]: _old, ...rest } = memory
  if (opened.size === 0 && closed.size === 0) return rest
  return { ...rest, [libraryId]: { opened: [...opened], closed: [...closed] } }
}

const strings = (raw: unknown) => (Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [])

/** The stored JSON back into a memory; anything damaged reads as not remembered. */
export function parseFolderMemory(raw: string | null): FolderMemory {
  let data: unknown
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
  const memory: FolderMemory = {}
  for (const [id, entry] of Object.entries(data as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const e = entry as Record<string, unknown>
    memory[id] = { opened: strings(e.opened), closed: strings(e.closed) }
  }
  return memory
}
