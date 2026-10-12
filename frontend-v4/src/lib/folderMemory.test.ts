import { describe, expect, it } from 'vitest'
import { buildFolderTree } from './folderTree'
import { folderPaths, parseFolderMemory, recallOpen, rememberOpen } from './folderMemory'

const tree = buildFolderTree(['D:/pics/parent/a', 'D:/pics/parent/b', 'D:/pics/other'])

describe('which folders of the rail are open, per library', () => {
  it('knows every folder path of the tree', () => {
    const paths = folderPaths(tree)
    expect(paths.has('D:/pics/parent')).toBe(true)
    expect(paths.has('D:/pics/parent/a')).toBe(true)
  })

  it('remembers what was opened and closed by hand, per library', () => {
    let memory = rememberOpen({}, 'main', new Set(['D:/pics/parent']), new Set())
    memory = rememberOpen(memory, 'lib_2', new Set(), new Set(['D:/pics']))
    const paths = folderPaths(tree)
    expect(recallOpen(memory, 'main', paths)).toEqual({ opened: new Set(['D:/pics/parent']), closed: new Set() })
    expect(recallOpen(memory, 'lib_2', paths)).toEqual({ opened: new Set(), closed: new Set(['D:/pics']) })
    expect(recallOpen(memory, 'other', paths)).toEqual({ opened: new Set(), closed: new Set() })
  })

  it('leaves out folders that no longer exist', () => {
    const memory = rememberOpen({}, 'main', new Set(['D:/pics/parent', 'D:/gone']), new Set(['D:/gone/too']))
    expect(recallOpen(memory, 'main', folderPaths(tree))).toEqual({ opened: new Set(['D:/pics/parent']), closed: new Set() })
  })

  it('forgets a library with nothing opened or closed by hand', () => {
    const memory = rememberOpen({ main: { opened: ['D:/pics/parent'], closed: [] } }, 'main', new Set(), new Set())
    expect(memory).toEqual({})
  })

  it('reads damaged storage as nothing remembered', () => {
    expect(parseFolderMemory(null)).toEqual({})
    expect(parseFolderMemory('not json')).toEqual({})
    expect(parseFolderMemory('[1]')).toEqual({})
    expect(parseFolderMemory('{"main":{"opened":["a",3],"closed":"x"},"bad":5}')).toEqual({ main: { opened: ['a'], closed: [] } })
  })
})
