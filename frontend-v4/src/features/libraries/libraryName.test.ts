import { describe, expect, it } from 'vitest'
import { translate } from '../../i18n'
import { libraryName } from './libraryName'

const zh = (key: Parameters<typeof translate>[1]) => translate('zh-CN', key)
const en = (key: Parameters<typeof translate>[1]) => translate('en', key)

describe('libraryName', () => {
  it('shows the seeded default library in the UI language', () => {
    expect(libraryName({ name: 'Main library', is_default: true }, zh)).toBe('主图库')
    expect(libraryName({ name: 'Main library', is_default: true }, en)).toBe('Main library')
  })

  it('keeps a name the user chose, also for the default library', () => {
    expect(libraryName({ name: 'My renders', is_default: true }, zh)).toBe('My renders')
    expect(libraryName({ name: 'Main library', is_default: false }, zh)).toBe('Main library')
  })

  it('gives an empty name when there is no library', () => {
    expect(libraryName(undefined, zh)).toBe('')
  })
})
