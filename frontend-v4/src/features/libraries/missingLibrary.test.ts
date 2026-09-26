import { describe, expect, it } from 'vitest'
import type { LibrariesResponse, Library } from '../../api/types'
import { replacementLibrary } from './missingLibrary'

const lib = (id: string, isDefault = false): Library => ({ id, name: id, created_at: null, is_default: isDefault, image_count: 0 })
const list = (ids: string[], currentId: string): LibrariesResponse => ({ libraries: ids.map((id) => lib(id, id === 'main')), current_id: currentId })

describe('the library a tab moves to when its own is gone', () => {
  it('changes nothing while the list is not loaded yet', () => {
    expect(replacementLibrary('lib_gone', undefined)).toBeNull()
  })

  it('changes nothing while the tab\'s library is listed', () => {
    expect(replacementLibrary('lib_2', list(['main', 'lib_2'], 'main'))).toBeNull()
    expect(replacementLibrary('main', list(['main', 'lib_2'], 'lib_2'))).toBeNull()
  })

  it('a missing library: the server\'s current one when listed, else the first listed (V3.5\'s order)', () => {
    expect(replacementLibrary('lib_gone', list(['main', 'lib_2'], 'lib_2'))).toBe('lib_2')
    // the server echoes the id the request named, which is the gone one
    expect(replacementLibrary('lib_gone', list(['main', 'lib_2'], 'lib_gone'))).toBe('main')
    expect(replacementLibrary('lib_gone', list(['lib_3', 'main'], 'lib_gone'))).toBe('lib_3')
  })

  it('an empty list falls back to main, and never "moves" main onto itself', () => {
    expect(replacementLibrary('lib_gone', list([], 'lib_gone'))).toBe('main')
    expect(replacementLibrary('main', list([], 'main'))).toBeNull()
  })
})
