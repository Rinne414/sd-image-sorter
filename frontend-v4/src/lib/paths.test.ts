import { describe, expect, test } from 'vitest'
import { folderName, folderNameProblem, joinFolder, parentFolder, tailOfPath } from './paths'

describe('paths', () => {
  test('parent folder of a file or folder, Windows and POSIX', () => {
    expect(parentFolder('D:\\art\\set 1\\a.png')).toBe('D:\\art\\set 1')
    expect(parentFolder('D:\\art')).toBe('D:\\')
    expect(parentFolder('D:\\')).toBeNull()
    expect(parentFolder('/home/me/a.png')).toBe('/home/me')
    expect(parentFolder('/home')).toBe('/')
    expect(parentFolder('/')).toBeNull()
    expect(parentFolder('')).toBeNull()
  })

  test('the last name in a path, a drive or root staying whole', () => {
    expect(folderName('D:\\art\\keep')).toBe('keep')
    expect(folderName('D:\\art\\keep\\')).toBe('keep')
    expect(folderName('/home/me/keep')).toBe('keep')
    expect(folderName('D:\\')).toBe('D:')
    expect(folderName('/')).toBe('/')
  })

  test('join uses the separator the base already uses', () => {
    expect(joinFolder('D:\\art', 'keep')).toBe('D:\\art\\keep')
    expect(joinFolder('D:\\', 'keep')).toBe('D:\\keep')
    expect(joinFolder('/home/me', 'keep')).toBe('/home/me/keep')
    expect(joinFolder('/', 'keep')).toBe('/keep')
  })

  test('folder names the file system would refuse are named, not silently fixed', () => {
    expect(folderNameProblem('keep')).toBeNull()
    expect(folderNameProblem('精选 2026')).toBeNull()
    expect(folderNameProblem('')).toBe('empty')
    expect(folderNameProblem('   ')).toBe('empty')
    expect(folderNameProblem('a/b')).toBe('chars')
    expect(folderNameProblem('a:b')).toBe('chars')
    expect(folderNameProblem('..')).toBe('dots')
    expect(folderNameProblem('name.')).toBe('trailing')
    expect(folderNameProblem('CON')).toBe('reserved')
  })

  test('tail keeps the end of a long path, where the folder name is', () => {
    expect(tailOfPath('D:\\a\\b', 40)).toBe('D:\\a\\b')
    expect(tailOfPath('D:\\very long folder name\\another level\\final', 24)).toBe('…\\another level\\final')
  })
})

// Library folders come back from the backend as `L:/Pictures/...` (a drive with
// forward slashes): those split on `/`, so every folder chooser row shows its own end.
describe('each kind of path keeps its own separator', () => {
  test('a drive with forward slashes (L:/a/b)', () => {
    expect(parentFolder('L:/a/b')).toBe('L:/a')
    expect(parentFolder('L:/a')).toBe('L:/')
    expect(joinFolder('L:/a', 'keep')).toBe('L:/a/keep')
    expect(tailOfPath('L:/Pictures/AAA Reference/AAAno prompt', 21)).toBe('…/AAAno prompt')
    expect(tailOfPath('L:/Pictures/AAA Reference/AAAwith prompt', 21)).toBe('…/AAAwith prompt')
  })

  test('a drive with backslashes (L:\\a\\b), as before', () => {
    expect(parentFolder('L:\\a\\b')).toBe('L:\\a')
    expect(parentFolder('L:\\a')).toBe('L:\\')
    expect(joinFolder('L:\\a', 'keep')).toBe('L:\\a\\keep')
    expect(tailOfPath('L:\\Pictures\\AAA Reference\\AAAno prompt', 21)).toBe('…\\AAAno prompt')
  })

  test('a network share (\\\\server\\share\\x), as before', () => {
    expect(parentFolder('\\\\server\\share\\x')).toBe('\\\\server\\share')
    expect(joinFolder('\\\\server\\share', 'x')).toBe('\\\\server\\share\\x')
    expect(tailOfPath('\\\\server\\share\\some long folder\\x', 20)).toBe('…\\some long folder\\x')
  })

  test('a POSIX path (/home/u/x), as before', () => {
    expect(parentFolder('/home/u/x')).toBe('/home/u')
    expect(joinFolder('/home/u', 'x')).toBe('/home/u/x')
    expect(tailOfPath('/home/u/some long folder/x', 20)).toBe('…/some long folder/x')
  })

  test('a mixed path (any backslash) keeps the Windows separator, as before', () => {
    expect(parentFolder('L:\\a/b\\c')).toBe('L:\\a/b')
    expect(joinFolder('L:\\a/b', 'c')).toBe('L:\\a/b\\c')
    expect(tailOfPath('L:\\Pictures/AAA Reference\\AAAno prompt', 21)).toBe('…\\AAAno prompt')
  })

  test('a drive root with a forward slash (L:/)', () => {
    expect(parentFolder('L:/')).toBeNull()
    expect(joinFolder('L:/', 'keep')).toBe('L:/keep')
    expect(tailOfPath('L:/', 21)).toBe('L:/')
    expect(folderName('L:/')).toBe('L:')
  })

  test('a drive root with a backslash (L:\\), as before', () => {
    expect(parentFolder('L:\\')).toBeNull()
    expect(joinFolder('L:\\', 'keep')).toBe('L:\\keep')
    expect(tailOfPath('L:\\', 21)).toBe('L:\\')
    expect(folderName('L:\\')).toBe('L:')
  })
})
