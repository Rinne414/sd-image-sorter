import { describe, expect, it } from 'vitest'
import { defaultFolder, readOutputFolders, startFolder } from './outputFolders'

const answer = {
  root: 'D:\\out',
  builtin_root: 'C:\\app\\output',
  custom_root: 'D:\\out',
  folders: { censor: 'D:\\out\\censor', publish: 'D:\\out\\publish', collected: 'D:\\out\\collected', extra: 'x' },
}

describe('readOutputFolders', () => {
  it('reads the root and the folder of each known feature', () => {
    const out = readOutputFolders(answer)
    expect(out?.root).toBe('D:\\out')
    expect(out?.custom_root).toBe('D:\\out')
    expect(out?.folders).toEqual({ censor: 'D:\\out\\censor', publish: 'D:\\out\\publish', collected: 'D:\\out\\collected' })
  })
  it('refuses an answer that has no root, so no folder is ever made up', () => {
    expect(readOutputFolders(null)).toBeNull()
    expect(readOutputFolders({ folders: {} })).toBeNull()
    expect(readOutputFolders('x')).toBeNull()
  })
  it('treats a missing custom root as the program folder', () => {
    expect(readOutputFolders({ root: 'a', builtin_root: 'a' })?.custom_root).toBe('')
  })
})

describe('startFolder', () => {
  const out = readOutputFolders(answer)
  it('keeps what the user chose before', () => {
    expect(startFolder('E:\\mine', out, 'publish', ['F:\\old'])).toBe('E:\\mine')
  })
  it('starts in <root>/<feature> when nothing was chosen', () => {
    expect(startFolder('  ', out, 'publish', ['F:\\old'])).toBe('D:\\out\\publish')
    expect(defaultFolder(out, 'publish')).toBe('D:\\out\\publish')
  })
  it('falls back to the newest recent folder, then to the drive list, before the server has answered', () => {
    expect(startFolder('', null, 'publish', ['F:\\old', 'G:\\older'])).toBe('F:\\old')
    expect(startFolder('', undefined, 'publish', [])).toBeNull()
    expect(startFolder('', out, 'workflows', [])).toBeNull()
  })
})
