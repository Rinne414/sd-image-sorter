import { describe, expect, it } from 'vitest'
import {
  errorKeyFor,
  errorParams,
  extensionId,
  folderTail,
  nextRequest,
  pairingName,
  pastedPictureUrl,
  pictureFromItems,
  safeWebUrl,
  sourceLine,
} from './collectLogic'

const file = (name: string) => new File(['x'], name)

describe('pastedPictureUrl', () => {
  it('takes one web address, trimmed', () => {
    expect(pastedPictureUrl('  https://example.com/a.png \n')).toBe('https://example.com/a.png')
    expect(pastedPictureUrl('HTTP://example.com/a')).toBe('HTTP://example.com/a')
  })
  it('refuses other text', () => {
    expect(pastedPictureUrl('hello https://example.com')).toBeNull()
    expect(pastedPictureUrl('ftp://example.com/a.png')).toBeNull()
    expect(pastedPictureUrl('javascript:alert(1)')).toBeNull()
    expect(pastedPictureUrl('')).toBeNull()
  })
})

describe('pictureFromItems', () => {
  it('returns the first picture file', () => {
    const png = file('a.png')
    const items = [
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'application/pdf', getAsFile: () => file('a.pdf') },
      { kind: 'file', type: 'image/png', getAsFile: () => png },
    ]
    expect(pictureFromItems(items)).toBe(png)
  })
  it('returns null when there is no picture', () => {
    expect(pictureFromItems([{ kind: 'string', type: 'text/plain', getAsFile: () => null }])).toBeNull()
    expect(pictureFromItems([])).toBeNull()
  })
})

describe('folderTail', () => {
  it('keeps the last two parts of a Windows or POSIX path', () => {
    expect(folderTail('C:\\out\\collected\\2026-10-23')).toBe('collected/2026-10-23')
    expect(folderTail('/home/me/out/collected/2026-10-23/')).toBe('collected/2026-10-23')
    expect(folderTail('')).toBe('')
  })
})

describe('safeWebUrl', () => {
  it('keeps web addresses only', () => {
    expect(safeWebUrl('https://a.example/x')).toBe('https://a.example/x')
    expect(safeWebUrl('javascript:alert(1)')).toBe('')
    expect(safeWebUrl('file:///c:/x')).toBe('')
    expect(safeWebUrl(null)).toBe('')
  })
})

describe('sourceLine', () => {
  const words = { paste: 'the clipboard', url: 'a picture address' }
  const when = (v: string) => `at ${v}`
  it('names the page by its title, then its host', () => {
    const titled = sourceLine({ page_url: 'https://site.example/p/1', page_title: 'Cats', via: 'extension' }, words, when)
    expect(titled.name).toBe('Cats')
    const bare = sourceLine({ page_url: 'https://site.example/p/1', via: 'extension', collected_at: '2026-10-28' }, words, when)
    expect(bare.name).toBe('site.example')
    expect(bare.when).toBe('at 2026-10-28')
  })
  it('says the clipboard for a paste and the host for an address', () => {
    expect(sourceLine({ via: 'paste' }, words, when).name).toBe('the clipboard')
    expect(sourceLine({ via: 'url', source_url: 'https://img.example/a.png' }, words, when).name).toBe('img.example')
    expect(sourceLine({ via: 'url' }, words, when).name).toBe('a picture address')
  })
  it('drops links that are not web addresses', () => {
    const line = sourceLine({ page_url: 'javascript:1', source_url: 'https://img.example/a.png', via: 'extension' }, words, when)
    expect(line.pageUrl).toBe('')
    expect(line.imageUrl).toBe('https://img.example/a.png')
  })
})

describe('pairings', () => {
  it('names the browser once', () => {
    const base = { id: '1', browser: 'chrome', name: 'Chrome on this computer' }
    expect(pairingName(base, 'Browser')).toBe('Chrome on this computer')
    expect(pairingName({ ...base, name: 'Work laptop' }, 'Browser')).toBe('Work laptop (Chrome)')
    expect(pairingName({ ...base, browser: 'other', name: 'X' }, 'Browser')).toBe('X (Browser)')
  })
  it('reads the extension id from its origin', () => {
    expect(extensionId({ id: '1', name: 'a', browser: 'chrome', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' })).toBe('abcdefghijklmnopabcdefghijklmnop')
    expect(extensionId({ id: '1', name: 'a', browser: 'chrome', origin: null })).toBe('')
  })
  it('skips requests that were set aside', () => {
    const list = [
      { id: 'a', name: 'a', browser: 'chrome' },
      { id: 'b', name: 'b', browser: 'edge' },
    ]
    expect(nextRequest(list, new Set())?.id).toBe('a')
    expect(nextRequest(list, new Set(['a']))?.id).toBe('b')
    expect(nextRequest(list, new Set(['a', 'b']))).toBeNull()
  })
})

describe('errors', () => {
  it('maps known codes to a key and ignores others', () => {
    expect(errorKeyFor('collect_site_refused')).toBe('collect.err.collect_site_refused')
    expect(errorKeyFor('something_else')).toBeNull()
    expect(errorKeyFor(null)).toBeNull()
  })
  it('reads params flat or inside detail', () => {
    expect(errorParams({ params: { status: 403, reason: 'x', nope: {} } })).toEqual({ status: 403, reason: 'x' })
    expect(errorParams({ detail: { params: { status: 404 } } })).toEqual({ status: 404 })
    expect(errorParams(null)).toEqual({})
  })
})
