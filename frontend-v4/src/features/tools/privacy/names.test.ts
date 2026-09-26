import { describe, expect, it } from 'vitest'
import { resultName, safeName, stemOf, uniqueNames, zipName } from './names'

describe('privacy names', () => {
  it('a result keeps the original stem, or the rename, with its own extension', () => {
    expect(resultName('00012.webp', null, '.png')).toBe('00012.png')
    expect(resultName('a.b.jpeg', null, '.jpg')).toBe('a.b.jpg')
    expect(resultName('00012.webp', '  给朋友  ', '.png')).toBe('给朋友.png')
    expect(resultName('00012.webp', '   ', '.png')).toBe('00012.png')
    expect(resultName('clipboard.png', 'a/b:c*?', '.jpg')).toBe('a_b_c__.jpg')
  })

  it('never hands out an empty or unsafe name', () => {
    expect(safeName('...')).toBe('image')
    expect(safeName('name. ')).toBe('name')
    expect(safeName('tab\there')).toBe('tab_here')
    expect(stemOf('noext')).toBe('noext')
    expect(stemOf('.hidden')).toBe('.hidden')
  })

  it('repeated names in a ZIP are numbered, ignoring case like Windows', () => {
    expect(uniqueNames(['a.png', 'A.png', 'a.png', 'b.jpg', 'a (2).png'])).toEqual(['a.png', 'A (2).png', 'a (3).png', 'b.jpg', 'a (2) (2).png'])
  })

  it('the ZIP is named by the time it was made', () => {
    expect(zipName(new Date(2026, 8, 26, 9, 5, 7))).toBe('privacy-20260926-090507.zip')
  })
})
