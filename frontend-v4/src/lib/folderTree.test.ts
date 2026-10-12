import { describe, expect, test } from 'vitest'
import { ancestorPaths, buildFolderTree, defaultOpen, normalizeFolder, type FolderNode } from './folderTree'

/** The tree as "label [path]" lines, indented by depth, for readable expectations. */
function lines(nodes: FolderNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [`${'  '.repeat(depth)}${n.label} [${n.path}]${n.hasImages ? ' *' : ''}`, ...lines(n.children, depth + 1)])
}

describe('buildFolderTree', () => {
  test('a parent that only holds subfolders becomes its own row above them', () => {
    const tree = buildFolderTree(['L:/Pictures/AAA/parent/a', 'L:/Pictures/AAA/parent/b', 'L:/Pictures/AAA/other'])
    expect(lines(tree)).toEqual([
      'L:/Pictures/AAA [L:/Pictures/AAA]',
      '  other [L:/Pictures/AAA/other] *',
      '  parent [L:/Pictures/AAA/parent]',
      '    a [L:/Pictures/AAA/parent/a] *',
      '    b [L:/Pictures/AAA/parent/b] *',
    ])
  })

  test('a chain of folders with one subfolder each and no images folds into one row', () => {
    expect(lines(buildFolderTree(['D:/art/2026/09/keep']))).toEqual(['D:/art/2026/09/keep [D:/art/2026/09/keep] *'])
    // a folder in the chain that holds images itself stays its own row
    expect(lines(buildFolderTree(['D:/art', 'D:/art/2026/09']))).toEqual([
      'D:/art [D:/art] *',
      '  2026/09 [D:/art/2026/09] *',
    ])
  })

  test('drives, POSIX roots and backslashes', () => {
    const tree = buildFolderTree(['C:\\out\\a', 'E:/pics/b', '/home/me/x', '/home/me/y'])
    expect(lines(tree)).toEqual([
      '/home/me [/home/me]',
      '  x [/home/me/x] *',
      '  y [/home/me/y] *',
      'C:/out/a [C:/out/a] *',
      'E:/pics/b [E:/pics/b] *',
    ])
  })

  test('children sort by name, numbers in number order; duplicates and blanks are ignored', () => {
    const tree = buildFolderTree(['D:/s/item10', 'D:/s/item2', 'D:/s/Item1', 'D:/s/item2/', '', '  '])
    expect(tree[0]!.children.map((c) => c.label)).toEqual(['Item1', 'item2', 'item10'])
  })

  test('network shares keep their leading double slash', () => {
    expect(lines(buildFolderTree(['//nas/share/a', '//nas/share/b']))).toEqual([
      '//nas/share [//nas/share]',
      '  a [//nas/share/a] *',
      '  b [//nas/share/b] *',
    ])
  })
})

describe('normalizeFolder', () => {
  test('forward slashes, no trailing slash, roots kept', () => {
    expect(normalizeFolder('D:\\art\\')).toBe('D:/art')
    expect(normalizeFolder('/')).toBe('/')
    expect(normalizeFolder('  /home/me/ ')).toBe('/home/me')
  })
})

describe('opening the tree', () => {
  const tree = buildFolderTree(['L:/P/parent/a/deep', 'L:/P/parent/b', 'L:/P/other'])

  test('the top rows start open, deeper branches closed', () => {
    expect([...defaultOpen(tree)]).toEqual(['L:/P'])
  })

  test('every row above a folder, so the chosen one is visible', () => {
    // "a" has no images and one subfolder, so "a/deep" is one row under "parent"
    expect(ancestorPaths(tree, 'L:/P/parent/a/deep')).toEqual(['L:/P', 'L:/P/parent'])
    expect(ancestorPaths(tree, 'L:/P/parent/a/deep/deeper')).toEqual(['L:/P', 'L:/P/parent', 'L:/P/parent/a/deep'])
    expect(ancestorPaths(tree, 'L:\\P\\other')).toEqual(['L:/P'])
    expect(ancestorPaths(tree, 'Z:/elsewhere')).toEqual([])
  })
})
