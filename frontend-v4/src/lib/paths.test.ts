import { describe, expect, test } from 'vitest'
import { folderNameProblem, joinFolder, parentFolder, tailOfPath } from './paths'

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
