import { describe, expect, test } from 'vitest'
import { hidePaths } from './errorText'
import { withPromptWord } from './promptWord'

describe('withPromptWord: a prompt word clicked in the recipe column', () => {
  test('becomes a prompt: condition after what is already searched', () => {
    expect(withPromptWord('', 'smile')).toBe('prompt:smile')
    expect(withPromptWord('gen:nai ', 'smile')).toBe('gen:nai prompt:smile')
  })

  test('is quoted when it has spaces, and loses quotes of its own', () => {
    expect(withPromptWord('', 'silver hair')).toBe('prompt:"silver hair"')
    expect(withPromptWord('', 'say "hi"')).toBe('prompt:"say hi"')
  })

  test('is not added twice', () => {
    expect(withPromptWord('prompt:smile', 'smile')).toBe('prompt:smile')
  })

  test('an empty word changes nothing', () => {
    expect(withPromptWord('gen:nai', ' " ')).toBe('gen:nai')
  })
})

describe('hidePaths: an error text before it is shown or copied', () => {
  test('hides Windows and home paths, keeps the rest', () => {
    expect(hidePaths('cannot read D:\\Pictures\\mine\\a.png now')).toBe('cannot read <path> now')
    expect(hidePaths('open /home/alice/pics/a.png failed')).toBe('open <path> failed')
    expect(hidePaths('HTTP 500 on /api/images')).toBe('HTTP 500 on /api/images')
  })
})
