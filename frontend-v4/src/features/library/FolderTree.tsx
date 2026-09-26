import { useMemo, useState } from 'react'
import { useT } from '../../i18n'
import { ancestorPaths, buildFolderTree, defaultOpen, normalizeFolder, type FolderNode } from '../../lib/folderTree'
import { useApp } from '../../state/store'
import { Icon } from '../../ui/Icon'
import styles from './FolderTree.module.css'
import rail from './Rail.module.css'

interface Branches {
  isOpen: (path: string) => boolean
  toggle: (path: string, open: boolean) => void
  active: string | null
  choose: (path: string) => void
}

/**
 * The library's folders as a tree. Choosing a folder shows it and everything
 * under it; choosing it again shows every folder. The top rows start open,
 * and the rows above the chosen folder open by themselves.
 */
export function FolderTree({ folders }: { folders: string[] }) {
  const tree = useMemo(() => buildFolderTree(folders), [folders])
  const folder = useApp((s) => s.scope.folder)
  const setScope = useApp((s) => s.setScope)
  const active = folder ? normalizeFolder(folder) : null
  // What the user opened or closed by hand; everything else follows the defaults.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const auto = useMemo(() => new Set([...defaultOpen(tree), ...(active ? ancestorPaths(tree, active) : [])]), [tree, active])

  const branches: Branches = {
    isOpen: (path) => opened.has(path) || (!closed.has(path) && auto.has(path)),
    toggle: (path, open) => {
      const without = (set: ReadonlySet<string>) => new Set([...set].filter((p) => p !== path))
      setOpened(open ? without(opened) : new Set([...opened, path]))
      setClosed(open ? new Set([...closed, path]) : without(closed))
    },
    active,
    choose: (path) => setScope({ folder: active === path ? null : path }),
  }

  return (
    <ul className={rail.list} data-testid="folder-tree">
      {tree.map((node) => (
        <FolderRow key={node.path} node={node} depth={0} branches={branches} />
      ))}
    </ul>
  )
}

function FolderRow({ node, depth, branches }: { node: FolderNode; depth: number; branches: Branches }) {
  const t = useT()
  const hasChildren = node.children.length > 0
  const open = hasChildren && branches.isOpen(node.path)
  const slash = node.label.lastIndexOf('/', node.label.length - 2) + 1
  const cut = slash < node.label.length ? slash : 0
  return (
    <li>
      <div className={styles.line} style={{ paddingLeft: depth * 12 }}>
        {hasChildren ? (
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={open}
            aria-label={t('browse.folder.inside', { name: node.label })}
            title={t('browse.folder.inside', { name: node.label })}
            onClick={() => branches.toggle(node.path, open)}
          >
            <Icon name="caret" size={11} />
          </button>
        ) : (
          <span className={styles.toggle} aria-hidden />
        )}
        <button
          type="button"
          className={`${rail.row} ${styles.row}`}
          aria-pressed={branches.active === node.path}
          title={node.path}
          onClick={() => branches.choose(node.path)}
          data-testid="folder-row"
        >
          {/* a folded chain keeps its last folder in view: "L:/Pict…/AAA" */}
          {cut > 0 && <span className={styles.head}>{node.label.slice(0, cut)}</span>}
          <span className={styles.tail}>{node.label.slice(cut)}</span>
        </button>
      </div>
      {open && (
        <ul className={rail.list}>
          {node.children.map((child) => (
            <FolderRow key={child.path} node={child} depth={depth + 1} branches={branches} />
          ))}
        </ul>
      )}
    </li>
  )
}
