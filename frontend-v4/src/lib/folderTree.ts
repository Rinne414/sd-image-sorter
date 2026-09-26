// The rail's folder tree, built from the flat list of folders that hold images
// (GET /api/folders). Choosing a row scopes the library to that folder and
// everything under it (the backend's `folder` filter is recursive), so a
// parent that only holds subfolders is a useful row too. A chain of folders
// with one subfolder each and no images of their own shows as one row
// ("L:/Pictures/AAA"): choosing any folder in it would show the same images.

export interface FolderNode {
  /** The folder this row scopes to, with forward slashes. */
  path: string
  /** What the row shows: one folder name, or a folded chain "a/b/c". */
  label: string
  /** Holds images itself (not only through subfolders). */
  hasImages: boolean
  children: FolderNode[]
}

interface RawNode {
  path: string
  name: string
  hasImages: boolean
  children: Map<string, RawNode>
}

/** Forward slashes, no trailing slash (a bare root stays "/"). */
export function normalizeFolder(raw: string): string {
  const slashed = raw.trim().replace(/\\/g, '/')
  const trimmed = slashed.replace(/\/+$/, '')
  return trimmed || (slashed.startsWith('/') ? '/' : '')
}

/** Path segments; the first carries the root ("/", "//server", "C:"). */
function segments(path: string): string[] {
  if (path === '/') return ['/']
  if (path.startsWith('//')) {
    const [server = '', ...rest] = path.slice(2).split('/')
    return [`//${server}`, ...rest.filter(Boolean)]
  }
  if (path.startsWith('/')) return ['/', ...path.slice(1).split('/').filter(Boolean)]
  return path.split('/').filter(Boolean)
}

function join(parent: string, name: string): string {
  if (!parent) return name
  return parent.endsWith('/') ? `${parent}${name}` : `${parent}/${name}`
}

const byName = (a: FolderNode, b: FolderNode) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' })

/** A node with one subfolder and no images of its own takes on its child. */
function fold(node: RawNode): FolderNode {
  let label = node.name
  let current = node
  while (!current.hasImages && current.children.size === 1) {
    const only = [...current.children.values()][0]!
    label = join(label, only.name)
    current = only
  }
  return {
    path: current.path,
    label,
    hasImages: current.hasImages,
    children: [...current.children.values()].map(fold).sort(byName),
  }
}

export function buildFolderTree(folders: readonly string[]): FolderNode[] {
  const root: RawNode = { path: '', name: '', hasImages: false, children: new Map() }
  for (const raw of folders) {
    const path = normalizeFolder(raw)
    if (!path) continue
    let node = root
    for (const name of segments(path)) {
      let next = node.children.get(name)
      if (!next) {
        next = { path: join(node.path, name), name, hasImages: false, children: new Map() }
        node.children.set(name, next)
      }
      node = next
    }
    node.hasImages = true
  }
  return [...root.children.values()].map(fold).sort(byName)
}

/** Rows open at first: the top ones (V3.5 did the same). */
export function defaultOpen(tree: readonly FolderNode[]): Set<string> {
  return new Set(tree.filter((n) => n.children.length > 0).map((n) => n.path))
}

/** The rows above `folder`, top first, so opening them shows it. */
export function ancestorPaths(tree: readonly FolderNode[], folder: string): string[] {
  const target = normalizeFolder(folder)
  const found: string[] = []
  let level: readonly FolderNode[] = tree
  for (;;) {
    const next = level.find((n) => n.path !== target && target.startsWith(n.path.endsWith('/') ? n.path : `${n.path}/`))
    if (!next) return found
    found.push(next.path)
    level = next.children
  }
}
